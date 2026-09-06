-- Custom provider-group display name shared by models with the same upstream host.
-- NULL means no custom name; the UI falls back to the base_url hostname and the
-- Cursor model picker badge falls back to the model type label.
ALTER TABLE model_configs ADD COLUMN group_name TEXT;
