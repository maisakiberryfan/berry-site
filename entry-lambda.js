/**
 * AWS Lambda entry point
 * Uses @hono/aws-lambda adapter for API Gateway HTTP API (v2)
 * Also handles EventBridge scheduled events (cron)
 */

import { handle } from 'hono/aws-lambda'
import app, { handleCronTrigger } from './src/app.js'
import { compressLambdaResult } from './src/utils/lambda-compress.js'

const honoHandler = handle(app)

// Lambda 無 waitUntil：webhook 同步 await runAutoUpdate 會超過 PubSub hub ~10s
// callback timeout → hub 視為失敗重試 → 同一通知重複處理。
// 改為 async self-invoke：收到通知立即回 200，處理移到獨立的非同步調用。
// 以 globalThis hook 暴露給 app.js（CF 路徑無此 hook，走 waitUntil，不需打包 AWS SDK）
globalThis.__berryAsyncInvoke = async (payload) => {
  const fnName = process.env.AWS_LAMBDA_FUNCTION_NAME
  if (!fnName || process.env.AWS_SAM_LOCAL) return false
  try {
    const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda')
    const client = new LambdaClient({})
    await client.send(new InvokeCommand({
      FunctionName: fnName,
      InvocationType: 'Event',
      Payload: JSON.stringify(payload)
    }))
    return true
  } catch (e) {
    console.warn(`[ASYNC] self-invoke 失敗，回退同步執行: ${e.message}`)
    return false
  }
}

/**
 * Lambda handler
 * - API Gateway HTTP API events → Hono app
 * - EventBridge scheduled events → Cron handler
 * - Self-invoked async events → PubSub background processing
 */
export const handler = async (event, context) => {
  // Keep-warm ping — return immediately without initializing Hono/DB
  if (event.source === 'warmup') {
    return { statusCode: 200, body: 'warm' }
  }

  // Async self-invoke: PubSub background processing
  if (event.__berryAsync === 'pubsub') {
    const { runAutoUpdate } = await import('./src/cron-jobs/auto-update.js')
    try {
      await runAutoUpdate({}, 'recent', { pubsubVideoId: event.videoId }, 'PUBSUB')
    } catch (error) {
      console.error('PubSub async processing error:', error)
      try {
        const { sendDiscordNotification } = await import('./src/utils/discord-notifier.js')
        await sendDiscordNotification({}, {
          type: 'auto-update',
          result: { errors: [error.message] },
          success: false
        })
      } catch { /* 通知失敗不影響 */ }
    }
    return { statusCode: 200, body: 'async done' }
  }

  // EventBridge scheduled event
  if (event.source === 'aws.events' || event['detail-type'] === 'Scheduled Event') {
    // Pass env as empty object — Lambda uses process.env directly via platform.js
    await handleCronTrigger(event, {})
    return { statusCode: 200, body: 'Cron completed' }
  }

  // API Gateway HTTP API event → Hono
  const result = await honoHandler(event, context)
  return compressLambdaResult(result, event)
}
