-- Migration 029: Add rider_pickup_confirmed_at to bookings
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS rider_pickup_confirmed_at TIMESTAMPTZ;
