# OpenObsidian

## The engine is a separate repository

This product is built on **OpenSync**, an end-to-end encrypted sync engine
that lives in `openapps/opensync` — checked out **beside** this repository,
not inside it:

```text
openapps/
├── opensync/       the engine
└── openobsidian/   this repository
```

Every path into it is relative, so both have to be present to build. That is
deliberate, and the alternative was worse: a copy of the engine per product
drifts silently, and a disagreement between two copies of a wire format does
not present as a compile error — it presents as lost data.
