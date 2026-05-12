-- Boulevard MVP seed data (32 songs).
-- Run after schema.sql.
-- Mirrors src/lib/seed/songs.ts so the app behaves the same against
-- a real Supabase backend as it does in local-only mode.

insert into public.songs (id, title, audio_url, cover_url, genre, bpm, mood, energy_score, vocal_type, voice_gender, similarity_cluster, drop_timestamps, intro_length, activity_fit, duration_seconds)
values
  -- Cluster 0 — Chill / Lo-fi
  ('00000000-0000-4000-8000-000000000001', 'Velvet Mornings', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3', 'https://picsum.photos/seed/boulevard-sng_001/800/800', 'lofi', 78, 'calm', 0.20, 'instrumental', null, 0, '{}', 0, '{focus,calm,sleep}', 198),
  ('00000000-0000-4000-8000-000000000002', 'Coastal Glass',   'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3', 'https://picsum.photos/seed/boulevard-sng_002/800/800', 'lofi', 80, 'calm', 0.22, 'instrumental', null, 0, '{}', 0, '{focus,calm,late_night}', 212),
  ('00000000-0000-4000-8000-000000000003', 'Paper Lantern',   'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3', 'https://picsum.photos/seed/boulevard-sng_003/800/800', 'lofi', 72, 'dreamy', 0.18, 'instrumental', null, 0, '{}', 0, '{sleep,calm}', 224),
  ('00000000-0000-4000-8000-000000000004', 'Slow Tide',       'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-4.mp3', 'https://picsum.photos/seed/boulevard-sng_004/800/800', 'ambient', 65, 'dreamy', 0.15, 'instrumental', null, 0, '{}', 0, '{sleep,calm}', 240),
  -- Cluster 1 — Pop / Euphoric
  ('00000000-0000-4000-8000-000000000005', 'Neon Skyline',    'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-5.mp3', 'https://picsum.photos/seed/boulevard-sng_005/800/800', 'pop', 118, 'euphoric', 0.78, 'female', 'female', 1, '{}', 0, '{driving,euphoric,party}', 204),
  ('00000000-0000-4000-8000-000000000006', 'Sun Chaser',      'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-6.mp3', 'https://picsum.photos/seed/boulevard-sng_006/800/800', 'pop', 122, 'happy', 0.74, 'female', 'female', 1, '{}', 0, '{driving,euphoric}', 196),
  ('00000000-0000-4000-8000-000000000007', 'Open Window',     'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-7.mp3', 'https://picsum.photos/seed/boulevard-sng_007/800/800', 'pop', 114, 'happy', 0.66, 'mixed', null, 1, '{}', 0, '{driving,calm,euphoric}', 210),
  ('00000000-0000-4000-8000-000000000008', 'Westside Bloom',  'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-8.mp3', 'https://picsum.photos/seed/boulevard-sng_008/800/800', 'pop', 120, 'euphoric', 0.80, 'female', 'female', 1, '{}', 0, '{party,euphoric,driving}', 188),
  -- Cluster 2 — House / Dance
  ('00000000-0000-4000-8000-000000000009', 'Midnight Drive',  'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-9.mp3', 'https://picsum.photos/seed/boulevard-sng_009/800/800', 'house', 124, 'energetic', 0.85, 'male', 'male', 2, '{}', 0, '{party,driving,late_night}', 230),
  ('00000000-0000-4000-8000-00000000000a', 'Glass Tower',     'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-10.mp3','https://picsum.photos/seed/boulevard-sng_010/800/800', 'house', 126, 'energetic', 0.88, 'instrumental', null, 2, '{}', 0, '{party,gym,euphoric}', 244),
  ('00000000-0000-4000-8000-00000000000b', 'Pulse Engine',    'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-11.mp3','https://picsum.photos/seed/boulevard-sng_011/800/800', 'house', 128, 'energetic', 0.90, 'instrumental', null, 2, '{}', 0, '{gym,party}', 252),
  ('00000000-0000-4000-8000-00000000000c', 'Berlin Air',      'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-12.mp3','https://picsum.photos/seed/boulevard-sng_012/800/800', 'techno', 130, 'energetic', 0.92, 'instrumental', null, 2, '{}', 0, '{gym,party,late_night}', 268),
  -- Cluster 3 — Hip-hop / R&B
  ('00000000-0000-4000-8000-00000000000d', 'Late Plates',     'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3', 'https://picsum.photos/seed/boulevard-sng_013/800/800', 'hiphop', 92,  'moody', 0.62, 'male', 'male', 3, '{}', 0, '{driving,late_night}', 198),
  ('00000000-0000-4000-8000-00000000000e', 'Brown Sugar Sky', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3', 'https://picsum.photos/seed/boulevard-sng_014/800/800', 'rnb',    88,  'romantic', 0.50, 'female', 'female', 3, '{}', 0, '{late_night,calm}', 222),
  ('00000000-0000-4000-8000-00000000000f', 'East Ave',        'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3', 'https://picsum.photos/seed/boulevard-sng_015/800/800', 'hiphop', 95,  'moody', 0.66, 'male', 'male', 3, '{}', 0, '{driving,aggressive}', 184),
  ('00000000-0000-4000-8000-000000000010', 'Smoke & Velvet',  'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-4.mp3', 'https://picsum.photos/seed/boulevard-sng_016/800/800', 'rnb',    84,  'romantic', 0.45, 'mixed', null, 3, '{}', 0, '{late_night,calm}', 216),
  -- Cluster 4 — Cinematic / Focus
  ('00000000-0000-4000-8000-000000000011', 'North Wing',      'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-5.mp3', 'https://picsum.photos/seed/boulevard-sng_017/800/800', 'cinematic', 96,  'epic', 0.70, 'instrumental', null, 4, '{}', 0, '{focus,driving}', 240),
  ('00000000-0000-4000-8000-000000000012', 'Library Hours',   'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-6.mp3', 'https://picsum.photos/seed/boulevard-sng_018/800/800', 'cinematic', 84,  'focused', 0.40, 'instrumental', null, 4, '{}', 0, '{focus,calm}', 264),
  ('00000000-0000-4000-8000-000000000013', 'Iron Garden',     'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-7.mp3', 'https://picsum.photos/seed/boulevard-sng_019/800/800', 'cinematic', 100, 'epic', 0.74, 'instrumental', null, 4, '{}', 0, '{focus,aggressive}', 252),
  ('00000000-0000-4000-8000-000000000014', 'Slow Architecture','https://www.soundhelix.com/examples/mp3/SoundHelix-Song-8.mp3','https://picsum.photos/seed/boulevard-sng_020/800/800', 'cinematic', 78,  'focused', 0.35, 'instrumental', null, 4, '{}', 0, '{focus,calm,sleep}', 276),
  -- Cluster 5 — Indie / Sad
  ('00000000-0000-4000-8000-000000000015', 'Cigarette Rain',  'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-9.mp3', 'https://picsum.photos/seed/boulevard-sng_021/800/800', 'indie', 76, 'sad', 0.32, 'male', 'male', 5, '{}', 0, '{sad,late_night}', 218),
  ('00000000-0000-4000-8000-000000000016', 'Quiet Letters',   'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-10.mp3','https://picsum.photos/seed/boulevard-sng_022/800/800', 'indie', 82, 'sad', 0.30, 'female', 'female', 5, '{}', 0, '{sad,calm}', 232),
  ('00000000-0000-4000-8000-000000000017', 'Long November',   'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-11.mp3','https://picsum.photos/seed/boulevard-sng_023/800/800', 'indie', 80, 'sad', 0.35, 'male', 'male', 5, '{}', 0, '{sad,late_night}', 226),
  ('00000000-0000-4000-8000-000000000018', 'Folded Maps',     'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-12.mp3','https://picsum.photos/seed/boulevard-sng_024/800/800', 'indie', 88, 'dreamy', 0.42, 'mixed', null, 5, '{}', 0, '{calm,sad}', 208),
  -- Cluster 6 — Aggressive / Gym
  ('00000000-0000-4000-8000-000000000019', 'Hammer Lane',     'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3', 'https://picsum.photos/seed/boulevard-sng_025/800/800', 'rock', 140, 'aggressive', 0.95, 'male', 'male', 6, '{}', 0, '{gym,aggressive}', 220),
  ('00000000-0000-4000-8000-00000000001a', 'Concrete Jaw',    'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3', 'https://picsum.photos/seed/boulevard-sng_026/800/800', 'rock', 142, 'aggressive', 0.96, 'male', 'male', 6, '{}', 0, '{gym,aggressive}', 214),
  ('00000000-0000-4000-8000-00000000001b', 'Bear Trap',       'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3', 'https://picsum.photos/seed/boulevard-sng_027/800/800', 'trap', 150, 'aggressive', 0.93, 'male', 'male', 6, '{}', 0, '{gym,aggressive,party}', 198),
  -- Cluster 7 — Euphoric / Festival
  ('00000000-0000-4000-8000-00000000001c', 'Skyline Anthem',  'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-4.mp3', 'https://picsum.photos/seed/boulevard-sng_028/800/800', 'edm', 128, 'euphoric', 0.90, 'mixed', null, 7, '{}', 0, '{party,euphoric,gym}', 248),
  ('00000000-0000-4000-8000-00000000001d', 'Festival Heart',  'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-5.mp3', 'https://picsum.photos/seed/boulevard-sng_029/800/800', 'edm', 126, 'euphoric', 0.92, 'female', 'female', 7, '{}', 0, '{party,euphoric}', 256),
  ('00000000-0000-4000-8000-00000000001e', 'Atlas Hands',     'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-6.mp3', 'https://picsum.photos/seed/boulevard-sng_030/800/800', 'edm', 124, 'euphoric', 0.86, 'mixed', null, 7, '{}', 0, '{party,euphoric,driving}', 236),
  -- Extras
  ('00000000-0000-4000-8000-00000000001f', 'Forest Whisper',  'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-7.mp3', 'https://picsum.photos/seed/boulevard-sng_031/800/800', 'ambient', 60, 'dreamy', 0.12, 'instrumental', null, 0, '{}', 0, '{sleep,calm,focus}', 280),
  ('00000000-0000-4000-8000-000000000020', 'On My Way',       'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-8.mp3', 'https://picsum.photos/seed/boulevard-sng_032/800/800', 'indie',  92, 'hopeful', 0.55, 'male', 'male', 5, '{}', 0, '{driving,calm,euphoric}', 225)
on conflict (id) do nothing;
