# MultiLEIA text orchestration

## Ownership

MultiLEIA activities are authored in Designer. Workbench stores the published experiment snapshot, configures a text model and API key for every actor, and starts the runtime in Runner.

## Activity model

An activity contains at least two LEIA configurations and one orchestration object:

```json
{
  "mode": "multi",
  "openingLeiaId": "activity-leia-config-id",
  "problemLeiaId": "activity-leia-config-id",
  "maxInternalTurns": 2,
  "sharedTask": "Optional common objective"
}
```

`openingLeiaId` is the fallback first actor if dynamic routing is unavailable. `problemLeiaId` is independent and identifies the LEIA whose problem supplies the scenario, widgets, solution and evaluation for the whole activity. `maxInternalTurns` is a safety ceiling, not a required number of messages.

Every actor keeps its own persona and behaviour. The actor's original problem is ignored. The runtime explicitly applies the behaviour's method, role and tone to the shared problem, and Designer rejects publication when a behaviour's `process` differs from the shared problem's `process`.

## Runtime graph

Runner builds an implicit graph with the participant, every LEIA actor and an end node. The graph is not persisted as authored edges. A private coordinator session receives one `speak_as_leia_N` function tool per actor and manages a complete participant round:

1. The coordinator first calls `plan_multi_leia_turn`. The LLM uses the complete public context to classify the conversational audience as an individual, a named subset or the whole group, then chooses a single reply, multiple perspectives or an agent-to-agent discussion. Whole-group intent requires every available LEIA within the configured safety maximum, independently of professional role relevance.
2. It calls one LEIA tool with both a primary addressee and a private conversational instruction, then observes that actor's public message.
3. It can then call another LEIA tool, so every later decision includes what the previous actor said.
4. Agent-to-agent calls are labeled in the transcript, allowing the next LEIA to answer, challenge or build directly on the previous contribution instead of independently answering the participant.
5. The runtime does not infer group intent from keywords. It enforces the semantic LLM plan if the coordinator attempts to return `WAIT_FOR_PARTICIPANT` before its planned voices have contributed.
6. It returns `WAIT_FOR_PARTICIPANT` when the plan is complete and the group needs participant input.
7. The configured maximum always stops the round even if the coordinator would continue.

A round can therefore contain one to eight public LEIA messages. Actors may speak again later in the same round, so the maximum can be greater than the number of configured LEIAs. Providers without native function tools use the same one-tool-at-a-time protocol through structured JSON. Invalid coordinator output falls back to the preferred opening actor and returns control after its response.

Runner exposes the traversal as one SSE response. It emits `route` before an actor starts, `message` after each public response, and `complete` when control returns to the participant. Workbench persists every message before forwarding it through its own SSE stream to the browser.

## Shared memory and isolation

Every actor has an isolated provider session. The private coordinator also has a persistent provider session, including its tool calls and results. Runner keeps one ordered public transcript with labeled senders. Before an actor speaks, it receives only the public events added since its own cursor. Its provider session preserves its private conversation state, while the labeled transcript gives it the messages produced by the participant and the other LEIAs.

The persisted public event fields are `sequence`, `senderType`, `senderId`, `senderName`, `recipientIds`, `addressedToId`, `addressedToName`, `text`, `turnId` and `timestamp`.

## Current constraints

- Text mode only.
- At least two LEIAs.
- One shared problem per activity.
- Participant-facing widget tools are not supported inside a MultiLEIA turn; the coordinator's private speaking tools are internal Runner tools.
- One traversal at a time per session, protected by a Redis lock.
- A `turnId` acts as an idempotency key for completed Runner turns.

When a natively orchestrated actor tool fails, the coordinator receives an error result and can select a different LEIA. If a fallback traversal cannot recover after earlier public messages were produced, Runner returns those saved messages with `partial: true`. A fully successful traversal clears the partial state.
