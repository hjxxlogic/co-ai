-- role_id remains the sender role for backward compatibility.
ALTER TABLE items ADD COLUMN recipient_role_ids TEXT NOT NULL DEFAULT '["ALL"]'
  CHECK (json_valid(recipient_role_ids) AND json_type(recipient_role_ids) = 'array' AND json_array_length(recipient_role_ids) BETWEEN 1 AND 20);
