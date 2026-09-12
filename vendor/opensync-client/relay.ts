import { schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";

/** Kind 30078: addressable, so the relay keeps exactly one per (pubkey, kind, d). */
const KIND_POINTER = 30078;
const KIND_CONNECTION_AUTH = 22242;
const KIND_BLOSSOM_AUTH = 24242;

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export class Signer {
  readonly pubkey: string;

  constructor(private readonly secret: Uint8Array) {
    this.pubkey = bytesToHex(schnorr.getPublicKey(secret));
  }

  static generate(): Signer {
    return new Signer(schnorr.utils.randomPrivateKey());
  }

  static fromHex(hex: string): Signer {
    return new Signer(hexToBytes(hex));
  }

  toHex(): string {
    return bytesToHex(this.secret);
  }

  sign(kind: number, tags: string[][], content: string, createdAt: number): NostrEvent {
    const event = { pubkey: this.pubkey, created_at: createdAt, kind, tags, content };
    // NIP-01's canonical form, byte for byte, or the id will not match.
    const canonical = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
    const id = bytesToHex(sha256(utf8ToBytes(canonical)));
    return { ...event, id, sig: bytesToHex(schnorr.sign(id, this.secret)) };
  }
}

/**
 * The relay connection and the blob endpoint beside it.
 *
 * Pointers go over the socket, bytes go over HTTP. The relay is the
 * rendezvous, never the pipe.
 */
export class Relay {
  private socket: WebSocket | null = null;
  private connecting: Promise<WebSocket> | null = null;
  /**
   * The highest created_at published or seen.
   *
   * A relay resolves two replaceable events with the same created_at by
   * keeping the lexically smaller id, so a second write inside the same second
   * has a coin-flip chance of being silently discarded — with an OK in reply.
   * A vault saves more than once a second routinely.
   */
  private watermark = 0;

  constructor(
    private readonly wsUrl: string,
    private readonly httpUrl: string,
    private readonly signer: Signer,
  ) {}

  private now(): number {
    return Math.floor(Date.now() / 1000);
  }

  /**
   * Loopback is the one wrong address that looks right.
   *
   * `127.0.0.1` on a phone is the phone, so a relay running on a laptop is
   * unreachable and the failure reads as "cannot connect" — which sends
   * people to check firewalls and Wi-Fi rather than the one field that is
   * actually wrong.
   */
  private unreachable(): Error {
    const host = this.wsUrl.replace(/^wss?:\/\//, "").split(/[:/]/)[0];
    if (host === "127.0.0.1" || host === "localhost" || host === "::1") {
      return new Error(
        `${this.wsUrl} points at this device, not the computer running the relay. ` +
          "Use that computer's address on your network instead, such as ws://192.168.0.10:4848/",
      );
    }
    return new Error(`cannot reach relay at ${this.wsUrl}`);
  }

  private nextCreatedAt(): number {
    this.watermark = Math.max(this.now(), this.watermark + 1);
    return this.watermark;
  }

  private observe(createdAt: number): void {
    this.watermark = Math.max(this.watermark, createdAt);
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
    this.connecting = null;
  }

  private async connect(): Promise<WebSocket> {
    if (this.socket?.readyState === WebSocket.OPEN) return this.socket;
    if (this.connecting) return this.connecting;

    this.connecting = new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(this.wsUrl);
      let settled = false;

      const done = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) {
          this.connecting = null;
          reject(err);
        } else {
          this.socket = socket;
          resolve(socket);
        }
      };

      const timer = setTimeout(() => done(this.unreachable()), 15000);

      socket.onerror = () => done(this.unreachable());
      socket.onclose = () => {
        this.socket = null;
        this.connecting = null;
        done(new Error("relay closed the connection"));
      };

      socket.onopen = () => {
        // Do NOT resolve here. A relay with auth enabled sends its challenge
        // immediately after the socket opens, and anything published before
        // that handshake finishes is refused with "auth-required". Resolving
        // on open and letting the caller race the challenge is the bug this
        // shape exists to prevent.
        //
        // A relay that never asks is also fine: the grace timer below gives
        // up waiting and proceeds unauthenticated.
        setTimeout(() => done(), 3000);
      };

      socket.onmessage = (ev) => {
        const msg = safeParse(ev.data);
        if (!msg) return;
        if (msg[0] === "AUTH" && typeof msg[1] === "string") {
          socket.send(JSON.stringify(["AUTH", this.authEvent(msg[1])]));
          return;
        }
        // The OK for our AUTH is the signal that the connection is usable.
        if (msg[0] === "OK") done();
      };
    });
    return this.connecting;
  }

  private authEvent(challenge: string) {
    return this.signer.sign(
      KIND_CONNECTION_AUTH,
      [
        ["relay", this.wsUrl],
        ["challenge", challenge],
      ],
      "",
      this.now(),
    );
  }

  /** One request/response exchange, with the socket's own listener restored after. */
  private async exchange(send: unknown, isDone: (msg: any[]) => boolean): Promise<any[][]> {
    const socket = await this.connect();
    const collected: any[][] = [];

    return new Promise((resolve, reject) => {
      const previous = socket.onmessage;
      const timer = setTimeout(() => {
        socket.onmessage = previous;
        reject(new Error("relay did not answer"));
      }, 20000);

      socket.onmessage = (ev) => {
        const msg = safeParse(ev.data);
        if (!msg) return;
        if (msg[0] === "AUTH" && typeof msg[1] === "string") {
          // A relay may re-challenge mid-connection; answer and keep waiting.
          socket.send(JSON.stringify(["AUTH", this.authEvent(msg[1])]));
          return;
        }
        collected.push(msg);
        if (isDone(msg)) {
          clearTimeout(timer);
          socket.onmessage = previous;
          resolve(collected);
        }
      };
      socket.send(JSON.stringify(send));
    });
  }

  async fetchPointer(namespace: string): Promise<string | null> {
    const filter = {
      authors: [this.signer.pubkey],
      kinds: [KIND_POINTER],
      "#d": [namespace],
      limit: 1,
    };
    const messages = await this.exchange(["REQ", "p", filter], (m) => m[0] === "EOSE");
    const event = messages.filter((m) => m[0] === "EVENT").map((m) => m[2]).pop();
    try {
      this.socket?.send(JSON.stringify(["CLOSE", "p"]));
    } catch {
      /* the socket going away here changes nothing */
    }
    if (!event) return null;
    this.observe(event.created_at);
    return event.content as string;
  }

  async publishPointer(namespace: string, hexPayload: string): Promise<void> {
    const event = this.signer.sign(
      KIND_POINTER,
      [["d", namespace]],
      hexPayload,
      this.nextCreatedAt(),
    );
    const messages = await this.exchange(["EVENT", event], (m) => m[0] === "OK");
    const ok = messages.find((m) => m[0] === "OK");
    if (ok?.[2]) return;
    const note = String(ok?.[3] ?? "");
    // NIP-01's prefix for "your signature is fine and the answer is still no".
    // The same distinction the 403 gets on the blob path — an app that gets
    // past one meets the other on the same first run.
    if (note.startsWith("restricted:")) throw new NotAdmittedError(note);
    throw new Error(`relay refused the pointer: ${note || "no reason given"}`);
  }

  private blossomAuth(verb: string): string {
    const event = this.signer.sign(
      KIND_BLOSSOM_AUTH,
      [["t", verb], ["expiration", String(this.now() + 300)]],
      "",
      this.now(),
    );
    return `Nostr ${btoa(JSON.stringify(event))}`;
  }

  async hasBlob(id: string): Promise<boolean> {
    const res = await fetch(`${this.httpUrl}/${id}`, { method: "HEAD" });
    return res.ok;
  }

  async getBlob(id: string): Promise<Uint8Array | null> {
    const res = await fetch(`${this.httpUrl}/${id}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`fetching a blob failed: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async putBlob(bytes: Uint8Array): Promise<void> {
    const res = await fetch(`${this.httpUrl}/upload`, {
      method: "PUT",
      headers: { Authorization: this.blossomAuth("upload") },
      body: bytes as BodyInit,
    });
    if (res.status === 413) {
      // A 413 has two quite different causes and they need different answers.
      // The relay says "quota exceeded" in a JSON body when you are actually
      // out of space; a plain-text 413 is the server refusing the request
      // size before it ever looked at your account. Reporting the second as
      // "storage is full" sends people off to buy space they do not need.
      const detail = await res.text();
      if (detail.includes("quota exceeded")) throw new QuotaError(detail);
      throw new Error(`the relay refused a ${bytes.length} byte upload: ${detail}`);
    }
    // 403 is the relay saying it does not serve this account at all. Nothing
    // the client retries can change that — it needs a person to admit the
    // account, or the app pointed at a different relay — so it is its own
    // error rather than a status code with a JSON document stapled to it.
    // On a relay with a roster this is the first thing a fresh install meets.
    if (res.status === 403) throw new NotAdmittedError(await res.text());
    if (!res.ok) throw new Error(`upload failed: ${res.status} ${await res.text()}`);
  }

  /**
   * Ask the relay to forget a blob, and say whether it agreed.
   *
   * A boolean rather than a `void`, and it never throws. Deletion here is
   * advisory — Blossom's DELETE reaches whichever server you asked, an
   * operator may have it switched off, and a blob that was ever fetched was
   * ever copied. The one caller is a rotation sweeping ciphertext it has
   * already made unreadable: it is tidying, not protecting, and a relay's
   * housekeeping policy must not be able to fail a rotation that has already
   * happened.
   *
   * A 404 counts as success. The blob is not there, which is what was asked.
   */
  async deleteBlob(id: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.httpUrl}/${id}`, {
        method: "DELETE",
        headers: { Authorization: this.blossomAuth("delete") },
      });
      return res.ok || res.status === 404;
    } catch {
      return false;
    }
  }
}

export class QuotaError extends Error {
  constructor(detail: string) {
    super(`storage is full: ${detail}`);
    this.name = "QuotaError";
  }
}

/**
 * The relay does not serve this account.
 *
 * Its own class for the reason `QuotaError` is: the answer is different, and
 * a UI can only offer the right one if it can tell. Retrying never helps —
 * somebody has to admit the account, or the app has to be pointed somewhere
 * else — and a message that reads like a fault invites exactly the retry that
 * cannot work.
 */
export class NotAdmittedError extends Error {
  constructor(detail: string) {
    super(`this relay does not serve your account: ${reason(detail)}`);
    this.name = "NotAdmittedError";
  }
}

/**
 * The `reason` out of the relay's body, or the body as it came.
 *
 * Refusals arrive as `{"error":…,"reason":…}` over HTTP and as
 * `restricted: …` over the socket. Both carry a sentence written for a
 * person; neither should reach one wrapped in its own envelope.
 */
function reason(detail: string): string {
  if (detail.startsWith("restricted:")) return detail.slice("restricted:".length).trim();
  try {
    const body = JSON.parse(detail);
    if (typeof body?.reason === "string") return body.reason;
  } catch {
    // Not JSON. The text is the reason.
  }
  return detail;
}

function safeParse(data: unknown): any[] | null {
  if (typeof data !== "string") return null;
  try {
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
