-- ============================================================================
-- Migration v2.27 — SMS fixes found during a user-reported investigation
-- ============================================================================
-- sms_messages.kind never included 'reschedule_proposed', 'feedback_request',
-- or 'feedback_followup' — three kinds the frontend has been sending via
-- sendBookingSms()/queueFeedbackFollowup() all along. The actual SMS still
-- goes out (the provider call doesn't check this constraint), but the
-- audit-log insert for it fails — and since the Edge Function inserts a
-- whole batch of audit rows in one INSERT, a single row with one of these
-- three kinds silently takes down the audit logging for every OTHER
-- message in that same batch too (Postgres aborts the entire INSERT on a
-- constraint violation, not just the offending row). Confirmed by
-- reproducing the exact constraint violation against real Postgres.
-- Also adds staff_new_booking, for the new stylist-notification message
-- added alongside this fix (see src/App.jsx).
-- ============================================================================

alter table public.sms_messages drop constraint if exists sms_messages_kind_check;
alter table public.sms_messages add constraint sms_messages_kind_check
  check (kind in (
    'confirmation','reminder','cancellation','reschedule','campaign','loyalty','custom',
    'reconciliation_prompt','weekly_summary','predictive_rebooking',
    'reschedule_proposed','feedback_request','feedback_followup','staff_new_booking'
  ));
