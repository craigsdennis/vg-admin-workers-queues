# Video Game Admin

This is a WIP (like all of us) to gather information from IGDB and convert it into embeddings for Vectorize.

## Setup

```bash
npm install
```

### Twitch

Set up a Twitch Application and get your Twitch API Key and then generate a Token.

Copy [.dev.vars.example](./.dev.vars.example) to .dev.vars, and update with your values.

When you are ready to deploy set up the secrets

```bash
npx wrangler secret put XYZ
```
for each key and value (where XYZ is TWITCH_CLIENT_ID, etc.)

### Queues

Create two queues

```bash
npx wrangler queues create vg-gatherer
```

```bash
npx wrangler queues create vg-indexer
```

### Vectorize

Create the Vectorize database

```bash
npx wrangler vectorize create video-game-summaries --preset "@cf/baai/bge-large-en-v1.5"
```


## TODO

- [ ] Build an admin screen instead of GET /init
  - [ ] Allow for different sizes
- [ ] Is there a way to check total amount I am just setting 300000
