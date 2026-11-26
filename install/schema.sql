-- Menús en familia: esquema de base de datos (MySQL 5.7+ / MariaDB 10.3+)
-- Se puede importar desde phpMyAdmin o ejecutar con install.php

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS families (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(100) NOT NULL,
  invite_code VARCHAR(16) NOT NULL,
  api_key_enc TEXT NULL,
  ai_model VARCHAR(60) NOT NULL DEFAULT 'claude-opus-5-5',
  servings TINYINT UNSIGNED NOT NULL DEFAULT 0,
  meals VARCHAR(60) NOT NULL DEFAULT 'comida,cena',
  tips TEXT NULL,
  data_version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_invite (invite_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS users (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(80) NOT NULL,
  email VARCHAR(190) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  family_id INT UNSIGNED NULL,
  role ENUM('admin','member') NOT NULL DEFAULT 'member',
  notes VARCHAR(500) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_email (email),
  KEY idx_family (family_id),
  CONSTRAINT fk_users_family FOREIGN KEY (family_id) REFERENCES families(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS auth_tokens (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id INT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_token (token_hash),
  KEY idx_user (user_id),
  CONSTRAINT fk_tokens_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Gustos, no gustos y alergias de cada miembro
CREATE TABLE IF NOT EXISTS preferences (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id INT UNSIGNED NOT NULL,
  kind ENUM('like','dislike','allergy') NOT NULL,
  item VARCHAR(120) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_pref (user_id, kind, item),
  CONSTRAINT fk_prefs_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Un menú por familia y semana (week_start = lunes)
CREATE TABLE IF NOT EXISTS menus (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  family_id INT UNSIGNED NOT NULL,
  week_start DATE NOT NULL,
  instructions TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_week (family_id, week_start),
  CONSTRAINT fk_menus_family FOREIGN KEY (family_id) REFERENCES families(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Cada plato del menú. day: 0 = lunes ... 6 = domingo
CREATE TABLE IF NOT EXISTS menu_items (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  menu_id INT UNSIGNED NOT NULL,
  day TINYINT UNSIGNED NOT NULL,
  meal VARCHAR(20) NOT NULL,
  dish VARCHAR(200) NOT NULL DEFAULT '',
  notes VARCHAR(500) NULL,
  ingredients TEXT NULL,          -- JSON: [{"name":..,"quantity":..,"section":..}] o NULL si faltan
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_slot (menu_id, day, meal),
  CONSTRAINT fk_items_menu FOREIGN KEY (menu_id) REFERENCES menus(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Lista de la compra compartida
CREATE TABLE IF NOT EXISTS shopping_items (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  family_id INT UNSIGNED NOT NULL,
  name VARCHAR(150) NOT NULL,
  quantity VARCHAR(80) NULL,
  section VARCHAR(40) NOT NULL DEFAULT 'Otros',
  checked TINYINT(1) NOT NULL DEFAULT 0,
  source ENUM('menu','manual') NOT NULL DEFAULT 'manual',
  created_by INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_family (family_id),
  CONSTRAINT fk_shop_family FOREIGN KEY (family_id) REFERENCES families(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
