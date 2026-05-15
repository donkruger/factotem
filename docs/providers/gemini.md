# Google Gemini

This page is for operators considering Gemini for their NanoClaw
deployment. For the engineering build guide, see
[`docs/implementation/gemini-blueprint.md`](../implementation/gemini-blueprint.md);
for the long-run architectural contract, see
[`docs/PROVIDER_PLAYBOOK.md`](../PROVIDER_PLAYBOOK.md).

## What you get

- **Strong tool use** — Gemini can call your agent's tools (web search,
  file read, etc.) about as competently as Claude on common workflows.
  Slightly less reliable on long multi-tool chains.
- **Image understanding** — send Gemini a photo on WhatsApp and it can
  read it.
- **2 million tokens of conversation memory** — by far the longest
  context window of any provider on the registry. Roughly 3,000 pages
  of plain text, or about a year of dense daily chat history.
- **Generous free tier** — 1,500 messages/day on `gemini-2.5-flash`
  before you hit a paywall. Plenty for most personal use.

## What you don't get

- **No prompt caching.** Every message pays full token cost. If you
  enable open-DM mode (where strangers DM the agent), per-message
  cost runs roughly 3× what Claude charges. Either raise the daily
  budget or stay on Claude for open-DM groups.
- **No computer use.** Gemini can't drive a browser the way Claude
  can. If you've been asking your agent to take screenshots,
  navigate web apps, or fill in forms, those conversations will
  fail on Gemini.
- **No native code execution.** Gemini has a code-execution tool on
  its native API but we don't expose it (we route through Gemini's
  OpenAI-compatibility layer, which doesn't include this feature).
- **No grounding-with-search.** Same reason as code execution.

If you need any of these, stay on Claude.

## How to get an API key

1. Open [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey).
2. Sign in with a Google account. (Any Google account works — you
   don't need a Workspace seat.)
3. Click **Create API key**. The first time, pick *"Create API key in
   new project"*. After that you can keep adding keys to that same
   project.
4. Copy the long string starting with `AIza…`. That's your key.

The key never expires until you revoke it. Google offers no
key-rotation reminder, so you don't need to worry about it expiring
mid-conversation.

## What it costs

- **Free tier**: 1,500 messages per day on `gemini-2.5-flash`. Plenty
  for personal use. No credit card needed to start.
- **Paid**: You only pay if you exceed the free tier or pick the paid
  model. Rough math for a chatty WhatsApp group:
  - `gemini-2.5-flash`: ~$0.50/day
  - `gemini-2.5-pro`: ~$1–2/day
- **No commitment**: pay-as-you-go billing. Cancel any time by deleting
  the API key.

NanoClaw's dashboard shows your actual spend per day under **Cost** and
per-agent under each agent's detail page. Set a daily budget cap in the
group's config to hard-limit spend.

## Setting Gemini up

The wizard's provider step shows Gemini as one of the cards. Pick it,
paste the API key from Google AI Studio, and the wizard runs the rest.
No terminal commands, no editing config files by hand.

If you already finished setup on Claude:

1. Open the Factotem dashboard at `http://localhost:3001`.
2. Click **Agents** in the top nav.
3. Either:
   - **Switch your existing agent** — click the agent's name → click
     **Switch model** → pick Google Gemini in the modal → click through
     the diff (it shows what you gain / lose vs Claude) → optionally
     test with a prompt → commit.
   - **Add a second agent** — re-run the setup wizard. It detects
     your existing agent and offers *"Add another agent on a different
     provider"*. The wizard's provider picker shows Gemini as a card;
     paste the AI Studio key when prompted.

If you add a second agent, NanoClaw dispatches messages based on the
`@<trigger>` prefix the message starts with. *@Andy hi* still goes to
your Claude agent; *@Ben hi* goes to the new Gemini agent. Both agents
can live in the same WhatsApp group.

## Switching back

Open the agent's detail page → **Switch model** → pick Anthropic
Claude → commit. No data loss; the conversation history is shared
across providers. The next inbound message uses Claude.

You have **5 minutes** after the switch to roll it back from the
dashboard's **Audit** page — useful if you change your mind on the
first reply.

## When something goes wrong

The dashboard's **Errors** page surfaces every failed turn with a
diagnosis and a recovery button. Common Gemini-specific issues:

- **Rate-limited (HTTP 429)** — you've hit Gemini's free-tier RPM
  ceiling (15 requests per minute on `gemini-2.5-flash`, lower on
  `gemini-2.5-pro`). Wait a minute, or switch this agent to a paid
  model.
- **Model not found** — Google retires Gemini model names on a roughly
  18-month cadence. The dashboard's recovery action is "switch to the
  current default," which usually resolves it.
- **Auth failed** — most often, you revoked the key in Google AI
  Studio without re-pasting in NanoClaw. Re-run the wizard's
  credentials step.

## Switching mid-conversation: what to expect

When you switch an agent's provider, the new model picks up
mid-conversation. It has full access to the message history and any
CLAUDE.md memory the previous model wrote. **However**, model styles
differ — Gemini sometimes reformats lists differently, uses more
emoji, or asks clarifying questions where Claude would have made an
assumption. Operators usually notice the change in tone on the first
reply and adjust their prompting accordingly.

## Where to learn more

- [Google AI Studio API docs](https://ai.google.dev/) — Gemini's
  official documentation
- [Gemini pricing](https://ai.google.dev/pricing) — current rate-card
- [Gemini rate limits](https://ai.google.dev/gemini-api/docs/rate-limits)
  — the table of RPM and RPD caps per model and tier
- [NanoClaw PROVIDER_PLAYBOOK.md](../PROVIDER_PLAYBOOK.md) — the
  long-run architecture behind multi-provider support
