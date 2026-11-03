/*M!999999\- enable the sandbox mode */

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*M!100616 SET @OLD_NOTE_VERBOSITY=@@NOTE_VERBOSITY, NOTE_VERBOSITY=0 */;

LOCK TABLES `photos` WRITE;
/*!40000 ALTER TABLE `photos` DISABLE KEYS */;
INSERT INTO `photos` VALUES
(1,'','2026-11-03 03:23:48','2026-11-03 03:23:48','','ptnwpm1cvu0urc3i','image','','Owner','','','','owner-a','blue','',0,0,0,0,0,'Local','zz','','zz',0,0,0,0,'zz',-1,-1,-1,0,'',0,0,1,0,0,0,6,1,'','',1,'','2026-11-03 03:27:37','2026-11-03 03:27:37',NULL,NULL,NULL,NULL,NULL,NULL),
(2,'','2026-11-03 03:23:48','2026-11-03 03:23:48','','ptnwpm1qs1tpzf2f','image','','Green','','','','owner-b','green','',0,0,0,0,0,'Local','zz','','zz',0,0,0,0,'zz',-1,-1,-1,0,'',0,0,1,0,0,0,9,1,'','',1,'','2026-11-03 03:27:37','2026-11-03 03:27:37',NULL,NULL,NULL,NULL,NULL,NULL);
/*!40000 ALTER TABLE `photos` ENABLE KEYS */;
UNLOCK TABLES;

LOCK TABLES `files` WRITE;
/*!40000 ALTER TABLE `files` DISABLE KEYS */;
INSERT INTO `files` VALUES
(1,2,'ptnwpm1qs1tpzf2f','2026-11-03 03:23:48','79738896967652-9999999998-0-ftnwpm1w5vh9t17e','9999999998-0-ftnwpm1w5vh9t17e',0,'','ftnwpm1w5vh9t17e','owner-b/green.png','/','','98308fe1c37a0c1d21df04b0981c0a6f31f140de',1949,'png','png','image','image/png',1,0,0,0,0,0,0,0,0,640,480,1,'meta','',1.33,0,0,'','green','999999999','999999999',1023,75,'','',1793676228,'2026-11-03 03:27:37',321544958,'2026-11-03 03:27:37',0,NULL,NULL),
(2,1,'ptnwpm1cvu0urc3i','2026-11-03 03:23:48','79738896967652-9999999999-0-ftnwpm1uo56xpgfb','9999999999-0-ftnwpm1uo56xpgfb',0,'','ftnwpm1uo56xpgfb','owner-a/blue.png','/','','a8c5c895f4a7aa5276a801c5226bf6fd74a3768c',1948,'png','png','image','image/png',1,0,0,0,0,0,0,0,0,640,480,1,'meta','',1.33,0,0,'','blue','666666666','555555555',1023,63,'','',1793676228,'2026-11-03 03:27:37',493410000,'2026-11-03 03:27:37',0,NULL,NULL);
/*!40000 ALTER TABLE `files` ENABLE KEYS */;
UNLOCK TABLES;

LOCK TABLES `albums` WRITE;
/*!40000 ALTER TABLE `albums` DISABLE KEYS */;
INSERT INTO `albums` VALUES
(1,'atnwpm0uyxvmvt3z','','owner-a','owner-a','folder','Owner-A','','','','','','path:\"owner-a\" public:true','added','','','zz',2026,11,0,0,0,'a8c5c895f4a7aa5276a801c5226bf6fd74a3768c','','','2026-11-03 03:27:36','2026-11-03 03:27:36',NULL,NULL),
(2,'atnwpm0w1vm86jz5','','owner-b','owner-b','folder','Owner-B','','','','','','path:\"owner-b\" public:true','added','','','zz',2026,11,0,0,0,'98308fe1c37a0c1d21df04b0981c0a6f31f140de','','','2026-11-03 03:27:36','2026-11-03 03:27:36',NULL,NULL);
/*!40000 ALTER TABLE `albums` ENABLE KEYS */;
UNLOCK TABLES;

LOCK TABLES `photos_albums` WRITE;
/*!40000 ALTER TABLE `photos_albums` DISABLE KEYS */;
/*!40000 ALTER TABLE `photos_albums` ENABLE KEYS */;
UNLOCK TABLES;

LOCK TABLES `albums_users` WRITE;
/*!40000 ALTER TABLE `albums_users` DISABLE KEYS */;
/*!40000 ALTER TABLE `albums_users` ENABLE KEYS */;
UNLOCK TABLES;

LOCK TABLES `photos_users` WRITE;
/*!40000 ALTER TABLE `photos_users` DISABLE KEYS */;
/*!40000 ALTER TABLE `photos_users` ENABLE KEYS */;
UNLOCK TABLES;

LOCK TABLES `photos_labels` WRITE;
/*!40000 ALTER TABLE `photos_labels` DISABLE KEYS */;
/*!40000 ALTER TABLE `photos_labels` ENABLE KEYS */;
UNLOCK TABLES;

LOCK TABLES `photos_keywords` WRITE;
/*!40000 ALTER TABLE `photos_keywords` DISABLE KEYS */;
INSERT INTO `photos_keywords` VALUES
(1,1),
(2,2),
(1,3),
(2,4);
/*!40000 ALTER TABLE `photos_keywords` ENABLE KEYS */;
UNLOCK TABLES;

LOCK TABLES `labels` WRITE;
/*!40000 ALTER TABLE `labels` DISABLE KEYS */;
/*!40000 ALTER TABLE `labels` ENABLE KEYS */;
UNLOCK TABLES;

LOCK TABLES `keywords` WRITE;
/*!40000 ALTER TABLE `keywords` DISABLE KEYS */;
INSERT INTO `keywords` VALUES
(1,'blue',0),
(2,'green',0),
(3,'owner',0),
(4,'owner',0);
/*!40000 ALTER TABLE `keywords` ENABLE KEYS */;
UNLOCK TABLES;

LOCK TABLES `details` WRITE;
/*!40000 ALTER TABLE `details` DISABLE KEYS */;
INSERT INTO `details` VALUES
(1,'blue, owner','','','','','','','','','','','','','','2026-11-03 03:27:37','2026-11-03 03:27:37'),
(2,'green, owner','','','','','','','','','','','','','','2026-11-03 03:27:37','2026-11-03 03:27:37');
/*!40000 ALTER TABLE `details` ENABLE KEYS */;
UNLOCK TABLES;

LOCK TABLES `subjects` WRITE;
/*!40000 ALTER TABLE `subjects` DISABLE KEYS */;
/*!40000 ALTER TABLE `subjects` ENABLE KEYS */;
UNLOCK TABLES;

LOCK TABLES `reactions` WRITE;
/*!40000 ALTER TABLE `reactions` DISABLE KEYS */;
/*!40000 ALTER TABLE `reactions` ENABLE KEYS */;
UNLOCK TABLES;

LOCK TABLES `cameras` WRITE;
/*!40000 ALTER TABLE `cameras` DISABLE KEYS */;
INSERT INTO `cameras` VALUES
(1,'zz','Unknown','','Unknown','','','','','2026-11-03 03:27:35','2026-11-03 03:27:35',NULL);
/*!40000 ALTER TABLE `cameras` ENABLE KEYS */;
UNLOCK TABLES;

LOCK TABLES `lenses` WRITE;
/*!40000 ALTER TABLE `lenses` DISABLE KEYS */;
INSERT INTO `lenses` VALUES
(1,'zz','Unknown','','Unknown','','','','','2026-11-03 03:27:35','2026-11-03 03:27:35',NULL);
/*!40000 ALTER TABLE `lenses` ENABLE KEYS */;
UNLOCK TABLES;

LOCK TABLES `places` WRITE;
/*!40000 ALTER TABLE `places` DISABLE KEYS */;
INSERT INTO `places` VALUES
('zz','Unknown','Unknown','Unknown','Unknown','zz','',0,2,'2026-11-03 03:27:35','2026-11-03 03:27:35');
/*!40000 ALTER TABLE `places` ENABLE KEYS */;
UNLOCK TABLES;

LOCK TABLES `cells` WRITE;
/*!40000 ALTER TABLE `cells` DISABLE KEYS */;
INSERT INTO `cells` VALUES
('zz','','','','','zz','2026-11-03 03:27:35','2026-11-03 03:27:35');
/*!40000 ALTER TABLE `cells` ENABLE KEYS */;
UNLOCK TABLES;

LOCK TABLES `countries` WRITE;
/*!40000 ALTER TABLE `countries` DISABLE KEYS */;
INSERT INTO `countries` VALUES
('zz','zz','Unknown','','',0);
/*!40000 ALTER TABLE `countries` ENABLE KEYS */;
UNLOCK TABLES;

LOCK TABLES `folders` WRITE;
/*!40000 ALTER TABLE `folders` DISABLE KEYS */;
INSERT INTO `folders` VALUES
('','/','dtnwpm09l10jvt1s','','Originals','','','name','zz',2026,11,0,0,0,0,0,'2026-11-03 03:27:36','2026-11-03 03:27:36','2026-11-03 03:23:48',NULL,NULL),
('owner-a','/','dtnwpm0w2spo89ow','','Owner-A','','','name','zz',2026,11,0,0,0,0,0,'2026-11-03 03:27:36','2026-11-03 03:27:36','2026-11-03 03:23:48',NULL,NULL),
('owner-b','/','dtnwpm0z2ez5bo1n','','Owner-B','','','name','zz',2026,11,0,0,0,0,0,'2026-11-03 03:27:36','2026-11-03 03:27:36','2026-11-03 03:23:48',NULL,NULL);
/*!40000 ALTER TABLE `folders` ENABLE KEYS */;
UNLOCK TABLES;

LOCK TABLES `duplicates` WRITE;
/*!40000 ALTER TABLE `duplicates` DISABLE KEYS */;
/*!40000 ALTER TABLE `duplicates` ENABLE KEYS */;
UNLOCK TABLES;

LOCK TABLES `migrations` WRITE;
/*!40000 ALTER TABLE `migrations` DISABLE KEYS */;
INSERT INTO `migrations` VALUES
('20211121-094727','mysql','main','','','2026-11-03 03:27:35','2026-11-03 03:27:35'),
('20211124-120008','mysql','main','','','2026-11-03 03:27:35','2026-11-03 03:27:35'),
('20220329-030000','mysql','main','','','2026-11-03 03:27:35','2026-11-03 03:27:35'),
('20220329-040000','mysql','main','','','2026-11-03 03:27:35','2026-11-03 03:27:35'),
('20220329-050000','mysql','main','','','2026-11-03 03:27:35','2026-11-03 03:27:35'),
('20220329-060000','mysql','main','','','2026-11-03 03:27:35','2026-11-03 03:27:35'),
('20220329-061000','mysql','main','','','2026-11-03 03:27:35','2026-11-03 03:27:35'),
('20220329-070000','mysql','main','','','2026-11-03 03:27:35','2026-11-03 03:27:35'),
('20220329-071000','mysql','main','','','2026-11-03 03:27:35','2026-11-03 03:27:35'),
('20220329-080000','mysql','main','','','2026-11-03 03:27:35','2026-11-03 03:27:35'),
('20220329-081000','mysql','main','','','2026-11-03 03:27:35','2026-11-03 03:27:35'),
('20220329-083000','mysql','main','','','2026-11-03 03:27:35','2026-11-03 03:27:35'),
('20220329-090000','mysql','main','','','2026-11-03 03:27:35','2026-11-03 03:27:35'),
('20220329-091000','mysql','main','','','2026-11-03 03:27:35','2026-11-03 03:27:35'),
('20220329-093000','mysql','main','','','2026-11-03 03:27:35','2026-11-03 03:27:35'),
('20220421-200000','mysql','main','','','2026-11-03 03:27:35','2026-11-03 03:27:35'),
('20220521-000001','mysql','main','','','2026-11-03 03:27:35','2026-11-03 03:27:35'),
('20220521-000002','mysql','main','','','2026-11-03 03:27:35','2026-11-03 03:27:35'),
('20220521-000003','mysql','main','','','2026-11-03 03:27:35','2026-11-03 03:27:35'),
('20220927-000100','mysql','main','','','2026-11-03 03:27:35','2026-11-03 03:27:35'),
('20221002-000100','mysql','main','','','2026-11-03 03:27:35','2026-11-03 03:27:35'),
('20221015-100000','mysql','pre','','','2026-11-03 03:27:33','2026-11-03 03:27:33'),
('20221015-100100','mysql','pre','','','2026-11-03 03:27:33','2026-11-03 03:27:33'),
('20230102-000001','mysql','main','','','2026-11-03 03:27:35','2026-11-03 03:27:35'),
('20230211-000001','mysql','main','','','2026-11-03 03:27:35','2026-11-03 03:27:35'),
('20230309-000001','mysql','main','','','2026-11-03 03:27:35','2026-11-03 03:27:35'),
('20230313-000001','mysql','main','','','2026-11-03 03:27:35','2026-11-03 03:27:35'),
('20240112-000001','mysql','main','','','2026-11-03 03:27:35','2026-11-03 03:27:35'),
('20240701-000001','mysql','main','','','2026-11-03 03:27:35','2026-11-03 03:27:35'),
('20240709-000001','mysql','pre','','','2026-11-03 03:27:33','2026-11-03 03:27:33'),
('20240915-000001','mysql','main','','','2026-11-03 03:27:35','2026-11-03 03:27:35'),
('20241010-000001','mysql','main','','','2026-11-03 03:27:35','2026-11-03 03:27:35'),
('20241202-000001','mysql','main','','','2026-11-03 03:27:35','2026-11-03 03:27:35'),
('20250117-000001','mysql','pre','','','2026-11-03 03:27:33','2026-11-03 03:27:33'),
('20250315-000001','mysql','pre','','','2026-11-03 03:27:33','2026-11-03 03:27:33'),
('20250416-000001','mysql','main','','','2026-11-03 03:27:35','2026-11-03 03:27:35'),
('20251005-000001','mysql','main','','','2026-11-03 03:27:35','2026-11-03 03:27:35'),
('20251007-000001','mysql','main','','','2026-11-03 03:27:35','2026-11-03 03:27:35'),
('20260601-000001','mysql','main','','','2026-11-03 03:27:35','2026-11-03 03:27:35'),
('20260602-000001','mysql','main','','','2026-11-03 03:27:35','2026-11-03 03:27:35'),
('20260612-000001','mysql','main','','','2026-11-03 03:27:35','2026-11-03 03:27:35'),
('20260721-000001','mysql','main','','','2026-11-03 03:27:35','2026-11-03 03:27:35'),
('20260721-000002','mysql','main','','','2026-11-03 03:27:35','2026-11-03 03:27:35'),
('20260828-000001','mysql','main','','','2026-11-03 03:27:35','2026-11-03 03:27:35'),
('20261010-000002','mysql','main','','','2026-11-03 03:27:35','2026-11-03 03:27:35'),
('20261010-000003','mysql','main','','','2026-11-03 03:27:35','2026-11-03 03:27:35'),
('20261010-000004','mysql','pre','','','2026-11-03 03:27:33','2026-11-03 03:27:33'),
('20261011-000001','mysql','main','','','2026-11-03 03:27:35','2026-11-03 03:27:35');
/*!40000 ALTER TABLE `migrations` ENABLE KEYS */;
UNLOCK TABLES;

LOCK TABLES `versions` WRITE;
/*!40000 ALTER TABLE `versions` DISABLE KEYS */;
INSERT INTO `versions` VALUES
(1,'261029-963b58c50-Linux-ARM64-Plus','plus','','2026-11-03 03:27:33','2026-11-03 03:27:35','2026-11-03 03:27:35');
/*!40000 ALTER TABLE `versions` ENABLE KEYS */;
UNLOCK TABLES;
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*M!100616 SET NOTE_VERBOSITY=@OLD_NOTE_VERBOSITY */;
