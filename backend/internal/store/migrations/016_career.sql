-- Career / resume module: role tracks, company hiring profiles, confirmed facts.
CREATE TABLE career_role_tracks (
  id text PRIMARY KEY CHECK(length(id) BETWEEN 2 AND 40),
  title text NOT NULL CHECK(length(title) BETWEEN 2 AND 80),
  description text NOT NULL DEFAULT '' CHECK(length(description) <= 500),
  section_order jsonb NOT NULL CHECK(jsonb_typeof(section_order)='array'),
  keywords jsonb NOT NULL CHECK(jsonb_typeof(keywords)='object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE career_companies (
  id text PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 100),
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
  notes text NOT NULL DEFAULT '' CHECK(length(notes) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id, user_id),
  UNIQUE(user_id, name)
);
CREATE INDEX career_companies_owner ON career_companies(user_id, updated_at DESC, id DESC);

CREATE TABLE career_job_descriptions (
  id text PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 100),
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id text NOT NULL,
  title text NOT NULL DEFAULT '' CHECK(length(title) <= 200),
  raw_text text NOT NULL CHECK(length(raw_text) BETWEEN 20 AND 20000),
  extracted jsonb NOT NULL CHECK(jsonb_typeof(extracted)='object'),
  extraction_source text NOT NULL CHECK(extraction_source IN ('ai','keyword_fallback')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id, user_id),
  FOREIGN KEY(company_id, user_id) REFERENCES career_companies(id, user_id) ON DELETE CASCADE
);
CREATE INDEX career_jd_company ON career_job_descriptions(user_id, company_id, created_at DESC, id DESC);

CREATE TABLE career_hiring_profiles (
  company_id text NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  jd_count integer NOT NULL DEFAULT 0 CHECK(jd_count >= 0),
  skills jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(skills)='array'),
  tools jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(tools)='array'),
  seniority_signals jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(seniority_signals)='array'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id, user_id),
  FOREIGN KEY(company_id, user_id) REFERENCES career_companies(id, user_id) ON DELETE CASCADE
);

CREATE TABLE career_confirmed_facts (
  id text PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 100),
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action text NOT NULL CHECK(length(action) BETWEEN 1 AND 200),
  impact text NOT NULL CHECK(length(impact) BETWEEN 1 AND 400),
  metric text CHECK(metric IS NULL OR length(metric) BETWEEN 1 AND 120),
  skills text[] NOT NULL DEFAULT '{}',
  confirmed boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id, user_id)
);
CREATE INDEX career_facts_owner ON career_confirmed_facts(user_id, created_at DESC, id DESC);

INSERT INTO career_role_tracks(id, title, description, section_order, keywords) VALUES
(
  'devops',
  'DevOps Engineer',
  'CI/CD, infrastructure as code, observability, and platform automation.',
  '["summary","skills","experience","projects","certifications","education"]'::jsonb,
  '{"skills":[{"term":"ci/cd","weight":5},{"term":"infrastructure as code","weight":5},{"term":"observability","weight":4},{"term":"monitoring","weight":3},{"term":"automation","weight":4},{"term":"sre practices","weight":3}],"tools":[{"term":"kubernetes","weight":5},{"term":"docker","weight":5},{"term":"terraform","weight":5},{"term":"ansible","weight":4},{"term":"jenkins","weight":3},{"term":"github actions","weight":4},{"term":"prometheus","weight":4},{"term":"grafana","weight":3},{"term":"aws","weight":4},{"term":"helm","weight":3}],"seniority":[{"term":"senior","weight":3},{"term":"lead","weight":3},{"term":"staff","weight":4},{"term":"principal","weight":4}]}'::jsonb
),
(
  'backend',
  'Backend Engineer',
  'APIs, distributed systems, data stores, and service reliability.',
  '["summary","experience","skills","projects","education"]'::jsonb,
  '{"skills":[{"term":"api design","weight":5},{"term":"microservices","weight":4},{"term":"distributed systems","weight":5},{"term":"concurrency","weight":4},{"term":"database design","weight":4},{"term":"caching","weight":3},{"term":"message queues","weight":3}],"tools":[{"term":"go","weight":5},{"term":"java","weight":3},{"term":"python","weight":3},{"term":"postgresql","weight":5},{"term":"redis","weight":4},{"term":"kafka","weight":4},{"term":"grpc","weight":4},{"term":"rest","weight":3},{"term":"docker","weight":3}],"seniority":[{"term":"senior","weight":3},{"term":"staff","weight":4},{"term":"principal","weight":4},{"term":"lead","weight":3}]}'::jsonb
),
(
  'frontend',
  'Frontend Engineer',
  'UI architecture, accessibility, performance, and modern web frameworks.',
  '["summary","experience","projects","skills","education"]'::jsonb,
  '{"skills":[{"term":"accessibility","weight":4},{"term":"responsive design","weight":3},{"term":"performance","weight":4},{"term":"state management","weight":4},{"term":"design systems","weight":3},{"term":"testing","weight":3}],"tools":[{"term":"react","weight":5},{"term":"typescript","weight":5},{"term":"javascript","weight":4},{"term":"css","weight":3},{"term":"next.js","weight":4},{"term":"vite","weight":3},{"term":"webpack","weight":2},{"term":"jest","weight":3},{"term":"playwright","weight":3}],"seniority":[{"term":"senior","weight":3},{"term":"staff","weight":4},{"term":"lead","weight":3}]}'::jsonb
),
(
  'fullstack',
  'Full-Stack Engineer',
  'End-to-end product delivery across UI, APIs, and data.',
  '["summary","experience","skills","projects","education"]'::jsonb,
  '{"skills":[{"term":"full stack","weight":5},{"term":"api design","weight":4},{"term":"product delivery","weight":3},{"term":"system design","weight":4},{"term":"testing","weight":3}],"tools":[{"term":"react","weight":4},{"term":"typescript","weight":5},{"term":"node.js","weight":4},{"term":"postgresql","weight":4},{"term":"go","weight":3},{"term":"docker","weight":3},{"term":"rest","weight":3}],"seniority":[{"term":"senior","weight":3},{"term":"lead","weight":3},{"term":"staff","weight":4}]}'::jsonb
),
(
  'data',
  'Data Engineer',
  'Pipelines, warehousing, batch/stream processing, and data quality.',
  '["summary","skills","experience","projects","education"]'::jsonb,
  '{"skills":[{"term":"etl","weight":5},{"term":"data modeling","weight":5},{"term":"data quality","weight":4},{"term":"streaming","weight":4},{"term":"batch processing","weight":4},{"term":"orchestration","weight":4}],"tools":[{"term":"spark","weight":5},{"term":"airflow","weight":5},{"term":"kafka","weight":4},{"term":"sql","weight":5},{"term":"dbt","weight":4},{"term":"snowflake","weight":3},{"term":"bigquery","weight":3},{"term":"python","weight":4},{"term":"parquet","weight":3}],"seniority":[{"term":"senior","weight":3},{"term":"staff","weight":4},{"term":"lead","weight":3}]}'::jsonb
),
(
  'ml',
  'Machine Learning Engineer',
  'Model training, evaluation, MLOps, and production inference.',
  '["summary","experience","skills","publications","projects","education"]'::jsonb,
  '{"skills":[{"term":"machine learning","weight":5},{"term":"deep learning","weight":4},{"term":"feature engineering","weight":4},{"term":"model evaluation","weight":4},{"term":"mlops","weight":5},{"term":"experiment tracking","weight":3}],"tools":[{"term":"python","weight":5},{"term":"pytorch","weight":5},{"term":"tensorflow","weight":3},{"term":"scikit-learn","weight":4},{"term":"mlflow","weight":3},{"term":"kubernetes","weight":3},{"term":"fastapi","weight":3}],"seniority":[{"term":"senior","weight":3},{"term":"staff","weight":4},{"term":"research","weight":3}]}'::jsonb
),
(
  'sre',
  'Site Reliability Engineer',
  'Reliability, incident response, SLOs, and capacity planning.',
  '["summary","skills","experience","projects","certifications","education"]'::jsonb,
  '{"skills":[{"term":"slo","weight":5},{"term":"incident response","weight":5},{"term":"capacity planning","weight":4},{"term":"reliability","weight":5},{"term":"on-call","weight":3},{"term":"chaos engineering","weight":3}],"tools":[{"term":"kubernetes","weight":5},{"term":"prometheus","weight":5},{"term":"grafana","weight":4},{"term":"terraform","weight":4},{"term":"linux","weight":4},{"term":"golang","weight":3},{"term":"python","weight":3}],"seniority":[{"term":"senior","weight":3},{"term":"staff","weight":4},{"term":"principal","weight":4}]}'::jsonb
),
(
  'mobile',
  'Mobile Engineer',
  'Native and cross-platform mobile apps, performance, and release.',
  '["summary","experience","projects","skills","education"]'::jsonb,
  '{"skills":[{"term":"mobile architecture","weight":5},{"term":"offline sync","weight":3},{"term":"performance","weight":4},{"term":"app store release","weight":3},{"term":"ui/ux","weight":3}],"tools":[{"term":"swift","weight":5},{"term":"kotlin","weight":5},{"term":"react native","weight":4},{"term":"flutter","weight":4},{"term":"ios","weight":4},{"term":"android","weight":4},{"term":"typescript","weight":3}],"seniority":[{"term":"senior","weight":3},{"term":"lead","weight":3},{"term":"staff","weight":4}]}'::jsonb
);
