package com.sme.meetingassistant.api.meetingexport;

/**
 * Private, checksum-verifying storage boundary for DE-09 worker processing.
 * DE-10 owns separately authorized user download capability issuance.
 */
public interface ExportArtifactStore {
    void putVerified(String key, byte[] bytes, String contentType, String sha256);
    byte[] readVerified(String key, String expectedSha256, int maximumBytes);

    /**
     * Compatibility for already persisted V1 snapshots only. Old workers
     * serialized unordered display maps, so identical JSON can have different
     * bytes across JVMs. Adapters without explicit reconciliation stay strict.
     * Never use this for intakes, V2 snapshots or rendered artifacts.
     */
    default void putLegacySnapshotVerified(String key, byte[] bytes,
            java.util.function.Predicate<byte[]> sameFrozenContent) {
        putVerified(key, bytes, "application/json", ExportSnapshotCodec.sha256(bytes));
    }

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
