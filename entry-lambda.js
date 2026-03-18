/**
 * AWS Lambda entry point
 * Uses @hono/aws-lambda adapter for API Gateway HTTP API (v2)
 * Also handles EventBridge scheduled events (cron)
 */

import { handle } from 'hono/aws-lambda'
import app, { handleCronTrigger } from './src/app.js'

const honoHandler = handle(app)

/**
 * Lambda handler
 * - API Gateway HTTP API events → Hono app
 * - EventBridge scheduled events → Cron handler
 */
export const handler = async (event, context) => {
  // Keep-warm ping — return immediately without initializing Hono/DB
  if (event.source === 'warmup') {
    return { statusCode: 200, body: 'warm' }
  }

  // EventBridge scheduled event
  if (event.source === 'aws.events' || event['detail-type'] === 'Scheduled Event') {
    // Pass env as empty object — Lambda uses process.env directly via platform.js
    await handleCronTrigger(event, {})
    return { statusCode: 200, body: 'Cron completed' }
  }

  // API Gateway HTTP API event → Hono
  return honoHandler(event, context)
}
