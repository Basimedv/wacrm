import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { CronExpressionParser } from 'cron-parser'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { resumePendingExecution, runTimeBasedAutomation } from '@/lib/automations/engine'
import type { AutomationContext } from '@/lib/automations/engine'
import type { Automation } from '@/types'

export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = supabaseAdmin()

  const { data: due, error } = await admin
    .from('automation_pending_executions')
    .select('*')
    .eq('status', 'pending')
    .lte('run_at', new Date().toISOString())
    .order('run_at', { ascending: true })
    .limit(50)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  let processed = 0
  for (const row of due ?? []) {
    const { data: claim } = await admin
      .from('automation_pending_executions')
      .update({ status: 'running' })
      .eq('id', row.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle()
    if (!claim) continue

    await resumePendingExecution({
      id: row.id as string,
      automation_id: row.automation_id as string,
      account_id: row.account_id as string,
      user_id: row.user_id as string,
      contact_id: (row.contact_id as string | null) ?? null,
      log_id: (row.log_id as string | null) ?? null,
      parent_step_id: (row.parent_step_id as string | null) ?? null,
      branch: (row.branch as 'yes' | 'no' | null) ?? null,
      next_step_position: row.next_step_position as number,
      context: (row.context as AutomationContext) ?? {},
    })
    processed++
  }

  const { data: timeBased, error: tbErr } = await admin
    .from('automations')
    .select('*')
    .eq('trigger_type', 'time_based')
    .eq('is_active', true)

  let timeBasedFired = 0
  if (tbErr) {
    console.error('[automations] cron: fetch time_based failed:', tbErr)
  } else {
    for (const automation of (timeBased ?? []) as Automation[]) {
      const cfg = automation.trigger_config as { schedule?: string } | null
      const rawSchedule = cfg?.schedule?.trim()
      if (!rawSchedule) continue

      let prevFire: Date
      try {
        const cronExpr = normalizeToCron(rawSchedule)
        const interval = CronExpressionParser.parse(cronExpr, { currentDate: new Date() })
        prevFire = interval.prev().toDate()
      } catch (err) {
        console.warn('[automations] cron: bad schedule on', automation.id, rawSchedule, err)
        continue
      }

      const now = new Date()
      if (prevFire > now) continue
      const lastTriggered = automation.last_executed_at
        ? new Date(automation.last_executed_at as string)
        : null
      if (lastTriggered && lastTriggered >= prevFire) continue

      const orClause = lastTriggered
        ? `last_executed_at.is.null,last_executed_at.lt.${prevFire.toISOString()}`
        : `last_executed_at.is.null`
      const { data: claimed } = await admin
        .from('automations')
        .update({ last_executed_at: prevFire.toISOString() })
        .eq('id', automation.id)
        .or(orClause)
        .select('id')
        .maybeSingle()
      if (!claimed) continue

      await runTimeBasedAutomation(automation)
      timeBasedFired++
    }
  }

  return NextResponse.json({ processed, timeBasedFired })
}

function normalizeToCron(schedule: string): string {
  const hhmm = schedule.match(/^([0-1]?\d|2[0-3]):([0-5]\d)$/)
  if (hhmm) {
    const [, h, m] = hhmm
    return `${Number(m)} ${Number(h)} * * *`
  }
  return schedule
}
