import type { DatabaseSync } from 'node:sqlite'

export interface CopilotTurn {
  turnId: string
  flowId: string
  actorId: string
  requestId: string
  requestDigest: string
  status: string
  message: string
  answer: string
  question: string | null
  revisionId: string | null
  createdAt: number
}

const columns = `turn_id AS turnId, flow_id AS flowId, actor_id AS actorId, request_id AS requestId,
  request_digest AS requestDigest, status, message, answer, question, revision_id AS revisionId, created_at AS createdAt`

export class CopilotStore {
  private readonly database: DatabaseSync
  constructor(database: DatabaseSync) {
    this.database = database
    database
      .prepare(
        "UPDATE jada_copilot_turns SET status = 'interrupted', answer = 'The server restarted. Saved workflow changes remain; send a new message to continue.' WHERE status = 'running'",
      )
      .run()
  }

  list(actorId: string, flowId: string): CopilotTurn[] {
    return this.database
      .prepare(
        `SELECT ${columns} FROM (SELECT * FROM jada_copilot_turns WHERE actor_id = ? AND flow_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 100) ORDER BY created_at, turn_id`,
      )
      .all(actorId, flowId) as unknown as CopilotTurn[]
  }

  find(actorId: string, flowId: string, requestId: string): CopilotTurn | undefined {
    return this.database
      .prepare(`SELECT ${columns} FROM jada_copilot_turns WHERE actor_id = ? AND flow_id = ? AND request_id = ?`)
      .get(actorId, flowId, requestId) as CopilotTurn | undefined
  }

  add(turn: CopilotTurn): void {
    this.database
      .prepare('INSERT INTO jada_copilot_turns(turn_id,flow_id,actor_id,request_id,request_digest,status,message,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(turn.turnId, turn.flowId, turn.actorId, turn.requestId, turn.requestDigest, 'running', turn.message, turn.createdAt)
  }

  finish(turnId: string, status: string, answer: string, revisionId?: string, question?: string): void {
    this.database
      .prepare('UPDATE jada_copilot_turns SET status=?, answer=?, revision_id=?, question=? WHERE turn_id=? AND status=?')
      .run(status, answer, revisionId ?? null, question ?? null, turnId, 'running')
  }

  append(turnId: string, event: unknown): void {
    const payload = JSON.stringify(event)
    if (Buffer.byteLength(payload) > 128 * 1024) throw new Error('Copilot event exceeds its limit.')
    this.database
      .prepare('INSERT INTO jada_copilot_events(turn_id,payload) SELECT ?,? WHERE EXISTS (SELECT 1 FROM jada_copilot_turns WHERE turn_id=?)')
      .run(turnId, payload, turnId)
  }

  events(actorId: string, flowId: string, after: number): { cursor: number; payload: string }[] {
    return this.database
      .prepare(`SELECT e.cursor,e.payload FROM jada_copilot_events e
      JOIN jada_copilot_turns t ON t.turn_id=e.turn_id WHERE t.actor_id=? AND t.flow_id=? AND e.cursor>? ORDER BY e.cursor LIMIT 100`)
      .all(actorId, flowId, after) as unknown as { cursor: number; payload: string }[]
  }
}
