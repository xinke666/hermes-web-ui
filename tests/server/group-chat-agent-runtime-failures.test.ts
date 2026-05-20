import { describe, expect, it, vi, beforeEach } from 'vitest'

import { groupChatRoutes, setGroupChatServer } from '../../packages/server/src/routes/hermes/group-chat'
import { AgentClients } from '../../packages/server/src/services/hermes/group-chat/agent-clients'

function routeHandler(path: string, method: string) {
  const layer = (groupChatRoutes as any).stack.find((item: any) => item.path === path && item.methods.includes(method))
  if (!layer) throw new Error(`Route not found: ${method} ${path}`)
  return layer.stack[0]
}

describe('Group Chat agent runtime failure visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does not block Add Agent on profile gateway health', async () => {
    const detectStatus = vi.fn().mockResolvedValue({
      profile: 'work',
      port: 8643,
      host: '127.0.0.1',
      url: 'http://127.0.0.1:8643',
      running: false,
      diagnostics: {
        reason: 'missing pid file',
        health_url: 'http://127.0.0.1:8643/health',
        health_checked_at: '2026-05-19T00:00:00.000Z',
      },
    })
    const storage = {
      getRoomAgents: vi.fn(() => []),
      addRoomAgent: vi.fn(() => ({ id: 'agent-1', profile: 'work', name: 'Worker' })),
    }
    const chatServer = {
      getStorage: () => storage,
      getGatewayManager: () => ({ detectStatus }),
      agentClients: {
        createAgent: vi.fn().mockResolvedValue({ agentId: 'runtime-agent-1' }),
        addAgentToRoom: vi.fn().mockResolvedValue(undefined),
      },
    }
    setGroupChatServer(chatServer as any)

    const handler = routeHandler('/api/hermes/group-chat/rooms/:roomId/agents', 'POST')
    const ctx: any = {
      params: { roomId: 'room-1' },
      request: { body: { profile: 'work', name: 'Worker' } },
      status: 200,
      body: undefined,
    }

    await handler(ctx, async () => {})

    expect(ctx.status).toBe(200)
    expect(ctx.body).toMatchObject({ agent: { profile: 'work', name: 'Worker' } })
    expect(detectStatus).not.toHaveBeenCalled()
    expect(chatServer.agentClients.createAgent).toHaveBeenCalledWith(expect.objectContaining({ profile: 'work' }))
    expect(chatServer.agentClients.addAgentToRoom).toHaveBeenCalled()
    expect(storage.addRoomAgent).toHaveBeenCalled()
  })

  it('returns a sanitized Add Agent connection failure without persisting the agent', async () => {
    const storage = {
      getRoomAgents: vi.fn(() => []),
      addRoomAgent: vi.fn(),
    }
    const chatServer = {
      getStorage: () => storage,
      getGatewayManager: () => ({
        detectStatus: vi.fn().mockResolvedValue({ profile: 'work', running: true }),
      }),
      agentClients: {
        createAgent: vi.fn().mockResolvedValue({ agentId: 'runtime-agent-1' }),
        addAgentToRoom: vi.fn().mockRejectedValue(new Error('token=super-secret failed')),
        removeAgentFromRoom: vi.fn(),
      },
    }
    setGroupChatServer(chatServer as any)

    const handler = routeHandler('/api/hermes/group-chat/rooms/:roomId/agents', 'POST')
    const ctx: any = {
      params: { roomId: 'room-1' },
      request: { body: { profile: 'work', name: 'Worker' } },
      status: 200,
      body: undefined,
    }

    await handler(ctx, async () => {})

    expect(ctx.status).toBe(502)
    expect(ctx.body).toMatchObject({
      code: 'PROFILE_AGENT_CONNECT_FAILED',
      profile: 'work',
      reason: 'token=[REDACTED] failed',
    })
    expect(JSON.stringify(ctx.body)).not.toContain('super-secret')
    expect(storage.addRoomAgent).not.toHaveBeenCalled()
  })

  it('rolls back runtime room membership when an agent join fails', async () => {
    const clients = new AgentClients()
    const client = {
      agentId: 'runtime-agent-1',
      name: 'Worker',
      joinRoom: vi.fn().mockRejectedValue(new Error('Not in room')),
      disconnect: vi.fn(),
    }

    await expect((clients as any).addAgentToRoom('room-1', client)).rejects.toThrow('Not in room')

    expect(clients.getAgents('room-1')).toEqual([])
    expect(client.disconnect).toHaveBeenCalled()
  })

  it('emits a visible agent error when a mentioned agent cannot reach its profile runtime', async () => {
    const clients = new AgentClients()
    const sendAgentError = vi.fn()
    ;(clients as any).setAgentErrorHandler(sendAgentError)

    const agent = {
      name: 'Worker',
      profile: 'work',
      emitContextStatus: vi.fn(),
      setAgentErrorHandler: vi.fn(),
      replyToMention: vi.fn().mockRejectedValue(new Error('fetch failed')),
    }
    ;(clients as any).rooms.set('room-1', new Map([['agent-1', agent]]))

    await clients.processMentions('room-1', {
      content: '@Worker please respond',
      senderName: 'Han',
      senderId: 'han',
      timestamp: Date.now(),
    })

    await vi.waitFor(() => expect(sendAgentError).toHaveBeenCalled())
    expect(sendAgentError).toHaveBeenCalledWith(expect.objectContaining({
      roomId: 'room-1',
      agentName: 'Worker',
      profile: 'work',
      code: 'PROFILE_AGENT_RUNTIME_DISPATCH_FAILED',
    }))
    expect(sendAgentError.mock.calls[0][0].message).toContain('Worker')
    expect(sendAgentError.mock.calls[0][0].message).not.toContain('stack')
  })
})
