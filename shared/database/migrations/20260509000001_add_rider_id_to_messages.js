/**
 * Migration: Add rider_id to messages table
 * - Scopes each message to a specific rider-driver conversation channel
 * - Nullable so existing rows are unaffected (clean break for old messages)
 */

exports.up = (pgm) => {
  pgm.addColumns('messages', {
    rider_id: {
      type: 'uuid',
      notNull: false,
      references: '"users"',
      onDelete: 'SET NULL',
    },
  });

  pgm.createIndex('messages', ['trip_id', 'rider_id'], {
    name: 'idx_messages_trip_rider',
  });

  console.log('Added rider_id column and index to messages table');
};

exports.down = (pgm) => {
  pgm.dropIndex('messages', ['trip_id', 'rider_id'], { name: 'idx_messages_trip_rider' });
  pgm.dropColumns('messages', ['rider_id']);
};
