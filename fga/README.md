# Authorization model

Everything that decides who may see or do something in Jisr resolves through
this model. There is no role column in the database on purpose: permissions live
here, and the application asks rather than assumes.

## Applying it

```bash
fga store create --name jisr
fga model write --store-id "$FGA_STORE_ID" --file fga/model.fga
# Fill in the ids that `pnpm seed` prints, then:
fga tuple write --store-id "$FGA_STORE_ID" --file fga/tuples.json
```

Put the returned store and model ids in `FGA_STORE_ID` and `FGA_MODEL_ID`.

## The checks the code actually makes

| Where | Check |
|---|---|
| A manager taps a button on a case card | `can_act` on `case:<id>` |
| The dashboard opens a case | `can_view` on `case:<id>` |
| The dashboard or Slack opens a speak-up report | `can_view_speakup` on `case:<id>` |
| A broadcast is composed | `can_view_cases` on each `site:<id>` |
| An HR approver is chosen for step 2 of a pay correction | `hr` on `company:<id>` |

Two things to note:

- **Speak-up is not `can_view`.** A supervisor has `can_view` on every case at
  their site. A speak-up report may be *about* that supervisor, so it is gated by
  `can_view_speakup`, which only HR and compliance hold.
- **Checks fail closed.** An unconfigured store, a network error, or an unknown
  relation all return `false` (`packages/integrations/src/auth0/fga.ts`). A check
  that cannot be answered is a check that failed.
