/** Immutable FL234/0725 capture body shared by migration and registered schema function. */
export const BACKUP_DELETION_CAPTURE_BODY = `
BEGIN
  INSERT INTO asset_backup_deletion ("assetId", "ownerId", "deletedAt", visibility, "wasLocked", checksum, "checksumAlgorithm", "livePhotoVideoId", "evidenceVersion", "modernPrivacyEvidenceUnavailable")
  VALUES (OLD.id, OLD."ownerId", clock_timestamp(), OLD.visibility::text,
    EXISTS (SELECT 1 FROM asset_lock WHERE "assetId" = OLD.id)
    OR (OLD.visibility::text = 'hidden' AND (
      EXISTS (SELECT 1 FROM asset AS parent JOIN asset_lock ON asset_lock."assetId" = parent.id
        WHERE parent."livePhotoVideoId" = OLD.id AND parent."ownerId" = OLD."ownerId")
      OR EXISTS (SELECT 1 FROM asset_backup_deletion AS parent
        WHERE parent."livePhotoVideoId" = OLD.id AND parent."ownerId" = OLD."ownerId" AND parent."wasLocked")
    )),
    OLD.checksum, OLD."checksumAlgorithm"::text, OLD."livePhotoVideoId", 1, true)
  ON CONFLICT ("assetId") DO UPDATE SET
    "ownerId" = EXCLUDED."ownerId", "deletedAt" = EXCLUDED."deletedAt", visibility = EXCLUDED.visibility,
    "wasLocked" = EXCLUDED."wasLocked", checksum = EXCLUDED.checksum, "checksumAlgorithm" = EXCLUDED."checksumAlgorithm",
    "livePhotoVideoId" = EXCLUDED."livePhotoVideoId", "evidenceVersion" = EXCLUDED."evidenceVersion",
    "modernPrivacyEvidenceUnavailable" = EXCLUDED."modernPrivacyEvidenceUnavailable";
  RETURN OLD;
END`;
