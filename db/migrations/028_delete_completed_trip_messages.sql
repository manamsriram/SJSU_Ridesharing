-- Schedule a cron job to delete messages from completed trips after 24 hours
-- Runs daily at 2 AM UTC

SELECT cron.schedule(
  'delete-completed-trip-messages',
  '0 2 * * *',
  $$
  DELETE FROM messages
  WHERE trip_id IN (
    SELECT trip_id FROM trips
    WHERE status = 'completed'
      AND completed_at < NOW() - INTERVAL '24 hours'
  );
  $$
);
