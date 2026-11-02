-- Seeded incident timelines were written as "11시 2분 0초"; the dashboard expects "11:02:00".
update alerts
   set timeline = (
     select coalesce(jsonb_agg(jsonb_build_array(
              regexp_replace(regexp_replace(e->>0, '(\d+)시 (\d+)분 (\d+)초', '\1:\2:\3'), '\m(\d)\M', '0\1', 'g'),
              e->>1) order by n), '[]'::jsonb)
       from jsonb_array_elements(timeline) with ordinality as t(e, n))
 where timeline::text like '%시 %분%';
