-- CSL 中文科技文献问答 Agent · MySQL 8.0 模式
-- 字符集统一 utf8mb4；全文索引使用 ngram 解析器以支持中文

CREATE DATABASE IF NOT EXISTS csl_agent
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE csl_agent;

-- ------------------------------------------------------------------ 文献库

CREATE TABLE IF NOT EXISTS papers (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  title VARCHAR(512) NOT NULL,
  abstract TEXT NOT NULL,
  keywords VARCHAR(512) NOT NULL DEFAULT '',
  discipline VARCHAR(64) NOT NULL DEFAULT '',
  category VARCHAR(32) NOT NULL DEFAULT '',
  content MEDIUMTEXT NOT NULL,
  abstract_start INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  FULLTEXT KEY ft_papers (title, abstract, keywords) WITH PARSER ngram,
  KEY idx_discipline (discipline),
  KEY idx_category (category)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------ 用户与会话

CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(32) NOT NULL,
  name VARCHAR(64) NOT NULL DEFAULT '访客',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS conversations (
  id VARCHAR(32) NOT NULL,
  user_id VARCHAR(32) NOT NULL,
  title VARCHAR(200) NOT NULL DEFAULT '新会话',
  workspace_id VARCHAR(64) NOT NULL DEFAULT 'default',
  message_count INT NOT NULL DEFAULT 0,
  archived TINYINT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_user_recent (user_id, archived, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS messages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  conversation_id VARCHAR(32) NOT NULL,
  role ENUM('user','assistant','system') NOT NULL,
  content MEDIUMTEXT NOT NULL,
  citations JSON NULL,
  task_id VARCHAR(32) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_conv (conversation_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS preferences (
  user_id VARCHAR(32) NOT NULL,
  data JSON NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------------ 任务编排

CREATE TABLE IF NOT EXISTS tasks (
  id VARCHAR(32) NOT NULL,
  conversation_id VARCHAR(32) NOT NULL,
  user_id VARCHAR(32) NOT NULL,
  question TEXT NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'queued',
  current_step VARCHAR(32) NOT NULL DEFAULT '',
  attempt INT NOT NULL DEFAULT 0,
  error TEXT NULL,
  checkpoint JSON NULL,
  result JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_status (status, updated_at),
  KEY idx_conv (conversation_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS task_steps (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  task_id VARCHAR(32) NOT NULL,
  name VARCHAR(40) NOT NULL,
  status VARCHAR(16) NOT NULL,
  detail JSON NULL,
  ms INT NOT NULL DEFAULT 0,
  attempt INT NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_task (task_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS approvals (
  id VARCHAR(32) NOT NULL,
  task_id VARCHAR(32) NOT NULL,
  user_id VARCHAR(32) NOT NULL,
  action VARCHAR(64) NOT NULL,
  payload JSON NOT NULL,
  reason VARCHAR(255) NOT NULL DEFAULT '',
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  decided_by VARCHAR(32) NULL,
  answer TEXT NULL,
  decided_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_pending (status, created_at),
  KEY idx_task (task_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id VARCHAR(32) NULL,
  action VARCHAR(64) NOT NULL,
  target VARCHAR(64) NULL,
  detail JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_time (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS metric_points (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(64) NOT NULL,
  value DOUBLE NOT NULL,
  labels JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_name_time (name, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------------ 用户知识库（上传文档）

CREATE TABLE IF NOT EXISTS kb_docs (
  id VARCHAR(32) NOT NULL,
  user_id VARCHAR(32) NOT NULL,
  name VARCHAR(255) NOT NULL,
  mime VARCHAR(100) NOT NULL DEFAULT '',
  size_bytes INT NOT NULL DEFAULT 0,
  char_count INT NOT NULL DEFAULT 0,
  chunk_count INT NOT NULL DEFAULT 0,
  text MEDIUMTEXT NOT NULL,
  kind VARCHAR(16) NOT NULL DEFAULT 'text',
  status VARCHAR(16) NOT NULL DEFAULT 'ready',
  error VARCHAR(255) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_user (user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS kb_extractions (
  doc_id VARCHAR(32) NOT NULL,
  metadata JSON NOT NULL,
  PRIMARY KEY (doc_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS kb_sections (
  id VARCHAR(40) NOT NULL PRIMARY KEY,
  user_id VARCHAR(32) NOT NULL,
  name VARCHAR(64) NOT NULL,
  summary TEXT NOT NULL,
  KEY idx_owner (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS kb_section_docs (
  section_id VARCHAR(40) NOT NULL,
  doc_id VARCHAR(32) NOT NULL,
  PRIMARY KEY (section_id, doc_id),
  FOREIGN KEY (section_id) REFERENCES kb_sections(id) ON DELETE CASCADE,
  FOREIGN KEY (doc_id) REFERENCES kb_docs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS kb_chunks (
  id VARCHAR(48) NOT NULL,
  doc_id VARCHAR(32) NOT NULL,
  user_id VARCHAR(32) NOT NULL,
  idx INT NOT NULL,
  heading VARCHAR(200) NOT NULL DEFAULT '',
  text MEDIUMTEXT NOT NULL,
  char_start INT NOT NULL DEFAULT 0,
  char_end INT NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_doc (doc_id, idx),
  KEY idx_user (user_id),
  FULLTEXT KEY ft_chunks (text, heading) WITH PARSER ngram
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
