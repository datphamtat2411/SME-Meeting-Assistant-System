package com.sme.meetingassistant.api.meetingexport;

/**
 * Private, checksum-verifying storage boundary for DE-09 worker processing.
 * DE-10 owns separately authorized user download capability issuance.
 */
public interface ExportArtifactStore {
    void putVerified(String key, byte[] bytes, String contentType, String sha256);
    byte[] readVerified(String key, String expectedSha256, int maximumBytes);

    final class StorageFailure extends RuntimeException {
        public StorageFailure(String safeDescription, Throwable cause) {
            super(safeDescription, cause);
        }
    }

    final class IntegrityFailure extends RuntimeException {
        public IntegrityFailure(String safeDescription) {
            super(safeDescription);
        }
    }
}
