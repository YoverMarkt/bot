import crypto from 'node:crypto'

export type WebhookProvider = 'meta' | 'ycloud'
export type WebhookInboxPayload = Record<string, unknown>
export type WebhookFailureStatus = 'pending' | 'dead' | 'stale'

export interface WebhookInboxLease {
  id: string
  business_id: string
  provider: WebhookProvider
  payload: WebhookInboxPayload
  lease_token: string
  attempts: number
}

export interface WebhookRpcError {
  message: string
  code?: string
  details?: string
  hint?: string
}

export interface WebhookRpcResponse<T> {
  data: T | null
  error: WebhookRpcError | null
}

export interface WebhookRpcClient {
  rpc(
    functionName: string,
    parameters?: Record<string, unknown>,
  ): PromiseLike<WebhookRpcResponse<unknown>>
}

const db = require('../client') as WebhookRpcClient

const sha256 = (value: string): string => crypto
  .createHash('sha256')
  .update(String(value))
  .digest('hex')

const rpc = async <T>(
  client: WebhookRpcClient,
  functionName: string,
  parameters?: Record<string, unknown>,
): Promise<WebhookRpcResponse<T>> => {
  const result = await client.rpc(functionName, parameters)
  return result as WebhookRpcResponse<T>
}

export function createWebhookEventsRepository(client: WebhookRpcClient) {
  const claimWebhookEvent = async (
    businessId: string,
    provider: WebhookProvider,
    messageId: string,
  ): Promise<WebhookRpcResponse<boolean>> => rpc<boolean>(
    client,
    'claim_webhook_event',
    {
      p_business_id: businessId,
      p_provider: provider,
      p_message_id_hash: sha256(messageId),
    },
  )

  const enqueueWebhookEvent = async (
    businessId: string,
    provider: WebhookProvider,
    messageId: string,
    conversationKey: string,
    payload: WebhookInboxPayload,
  ): Promise<WebhookRpcResponse<boolean>> => rpc<boolean>(
    client,
    'enqueue_webhook_event',
    {
      p_business_id: businessId,
      p_provider: provider,
      p_message_id_hash: sha256(messageId),
      p_stream_key_hash: sha256(conversationKey),
      p_payload: payload,
    },
  )

  const leaseWebhookEvents = async (
    workerId: string,
    limit: number,
    leaseSeconds: number,
  ): Promise<WebhookRpcResponse<WebhookInboxLease[]>> => rpc<WebhookInboxLease[]>(
    client,
    'lease_webhook_events',
    {
      p_worker_id: workerId,
      p_limit: limit,
      p_lease_seconds: leaseSeconds,
    },
  )

  const renewWebhookEventLease = async (
    eventId: string,
    leaseToken: string,
    leaseSeconds: number,
  ): Promise<WebhookRpcResponse<boolean>> => rpc<boolean>(
    client,
    'renew_webhook_event_lease',
    {
      p_event_id: eventId,
      p_lease_token: leaseToken,
      p_lease_seconds: leaseSeconds,
    },
  )

  const completeWebhookEvent = async (
    eventId: string,
    leaseToken: string,
  ): Promise<WebhookRpcResponse<boolean>> => rpc<boolean>(
    client,
    'complete_webhook_event',
    {
      p_event_id: eventId,
      p_lease_token: leaseToken,
    },
  )

  const failWebhookEvent = async (
    eventId: string,
    leaseToken: string,
    error: string,
    baseDelaySeconds: number,
  ): Promise<WebhookRpcResponse<WebhookFailureStatus>> => rpc<WebhookFailureStatus>(
    client,
    'fail_webhook_event',
    {
      p_event_id: eventId,
      p_lease_token: leaseToken,
      p_error: error,
      p_base_delay_seconds: baseDelaySeconds,
    },
  )

  const cleanupWebhookEvents = async (): Promise<WebhookRpcResponse<number>> => (
    rpc<number>(client, 'cleanup_webhook_events')
  )

  return {
    claimWebhookEvent,
    enqueueWebhookEvent,
    leaseWebhookEvents,
    renewWebhookEventLease,
    completeWebhookEvent,
    failWebhookEvent,
    cleanupWebhookEvents,
  }
}

const repository = createWebhookEventsRepository(db)

export const claimWebhookEvent = repository.claimWebhookEvent
export const enqueueWebhookEvent = repository.enqueueWebhookEvent
export const leaseWebhookEvents = repository.leaseWebhookEvents
export const renewWebhookEventLease = repository.renewWebhookEventLease
export const completeWebhookEvent = repository.completeWebhookEvent
export const failWebhookEvent = repository.failWebhookEvent
export const cleanupWebhookEvents = repository.cleanupWebhookEvents
