CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE amenity_bookings
  ADD CONSTRAINT amenity_booking_no_resident_overlap
  EXCLUDE USING gist (
    amenity_id WITH =,
    resident_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  )
  WHERE (status IN ('HELD', 'PENDING_PAYMENT', 'CONFIRMED'));
