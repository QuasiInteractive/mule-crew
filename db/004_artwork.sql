-- Artwork proofing policy, measured in code before the model looks:
--  min_artwork_dpi: below this at the ordered size, a print looks soft or pixelated.
--  min_artwork_sharpness: edge steepness vs tonal range (~1 crisp); below this the
--    file is a small image blown up, whatever its dpi says.
--  min_artwork_contrast: WCAG minimum contrast ratio for large text (3:1).
--  max_safe_zone_ink_pct: ink allowed in the 1/8 inch inside the cut line, as a
--    share of that band; above it, text or detail will be sliced or crowded.
INSERT INTO policy (key, value) VALUES
  ('min_artwork_dpi', '150'),
  ('min_artwork_sharpness', '0.4'),
  ('min_artwork_contrast', '3'),
  ('max_safe_zone_ink_pct', '1')
ON CONFLICT (key) DO NOTHING;
