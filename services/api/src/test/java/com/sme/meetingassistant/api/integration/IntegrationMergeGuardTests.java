package com.sme.meetingassistant.api.integration;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.Map;
import java.util.Properties;
import java.util.TreeMap;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;

/**
 * Task 04: prohibit a green build after historical Flyway SQL is silently
 * modified or a privileged production switch is enabled by default.
 *
 * The frozen digests are canonical Git blob object IDs obtained from the
 * reviewed develop V1-V39 plus byte-identical Export V40-V43 SQL. Forward-only
 * V44+ migrations are permitted; rewriting V1-V43 is not.
 */
class IntegrationMergeGuardTests {
    private static final Pattern VERSION = Pattern.compile("^V([1-9][0-9]*)__.+[.]sql$");
    private static final Map<String, String> FROZEN_SQL_BLOBS = Map.ofEntries(
            Map.entry("V1__create_canonical_identity_and_organizational_units.sql", "96ee38141c8aab411dae6b6e76fe663ec9a325e2"),
            Map.entry("V2__account_setup_and_email_delivery.sql", "6b2bfd73664ea94b5060c6adee751a757d1985a2"),
            Map.entry("V3__authentication_sessions_and_recovery.sql", "379d5ceeed0ab09ae6a13efd2c9e3a76a6a26ac3"),
            Map.entry("V4__authentication_security_controls.sql", "ef8bba92c4f4c0a298b3eca3f021007b02612088"),
            Map.entry("V5__create_canonical_room_catalog.sql", "0d6cc7f76ca15ab543f44a9fb3dcd5410117afda"),
            Map.entry("V6__create_canonical_meeting_core.sql", "88d8f368cf1b7a6a49d485ff89915ab621339597"),
            Map.entry("V7__create_canonical_room_reservations.sql", "576cc1d0f4cba59f8675fe03ddbc213508762d66"),
            Map.entry("V8__meeting_notification_supersession.sql", "ce7d564fd5ff5bd21294af8c81d3f72d9fdd37ef"),
            Map.entry("V9__meeting_audit_integrity.sql", "884dc501b1566ecc475ee924cb64ae81ed1e59c7"),
            Map.entry("V10__meeting_create_idempotency.sql", "18f8ad326e2393553cb1da02ff025a2219251880"),
            Map.entry("V11__create_media_processing_core.sql", "49def105752ec3a43d5dd6319c159e45e841cd35"),
            Map.entry("V12__immutable_media_finalization.sql", "00aa81b2aff735bf8c258fb98421c704181412b2"),
            Map.entry("V13__processing_job_admission_guards.sql", "f7852fe3f3552f7256fa22f6a3675a860d1236d9"),
            Map.entry("V14__fenced_outbox_publisher_claims.sql", "23871cb1a04683b6d7a359559478f43a308c4b90"),
            Map.entry("V15__processing_job_dispatch_state.sql", "b606b5d3536df1d86709fdb7e9808536b94d21bb"),
            Map.entry("V16__processing_attempts_and_artifact_references.sql", "61112fc135e15f645a94403ae53b6055f6849278"),
            Map.entry("V17__create_transcript_review.sql", "a39a07b420e1447f9d342136b3b94ab9366a1f9a"),
            Map.entry("V18__processing_stage_claims.sql", "b598c5ee2c26e82efd8f27af9c8f5c902a9f8c6c"),
            Map.entry("V19__processing_artifact_integrity.sql", "68c9b0ae9b19fccd76c70cb299d17e29e2668147"),
            Map.entry("V20__transcript_publication_identity.sql", "719adcdec4e1569f4c1d6ceee6355bb32a15231b"),
            Map.entry("V21__transcript_content_revision.sql", "38696ba43aa1ebdc319d2962ecd5b5f347268186"),
            Map.entry("V22__processing_transcript_provenance.sql", "46303ed0b1846e0344f2c970a069ee22492387c4"),
            Map.entry("V23__create_meeting_intelligence_core.sql", "3cb6ef43da33ddd4a1b38e84c9af0857fa90b108"),
            Map.entry("V24__summary_activation_epoch.sql", "7db85bb591d2d1f6b52bd6a5379cef691847a86b"),
            Map.entry("V25__meeting_intelligence_ai_quality_provenance.sql", "5fa63ffe730c23584e596b4f96b4e3a6f24a8af8"),
            Map.entry("V26__intelligence_orphan_scan_claims.sql", "83cc1dd8630685c4ee7e73ae4badccbb35b33f51"),
            Map.entry("V27__transcription_worker_receipts.sql", "494928e4760d4ec056cf71e4ad4c74476170c1d5"),
            Map.entry("V28__worker_dead_letter_reconciliation.sql", "ac2f21f4ed7ff6f252fe207cc29125289873d853"),
            Map.entry("V29__create_action_items.sql", "02bc8779172b16fbdef1e9ed67dcbf80d3211f3a"),
            Map.entry("V30__meeting_action_item_scope.sql", "00e7a4a26dfa43b1356b951c6364ca6467b23406"),
            Map.entry("V31__action_item_integrity_and_idempotency.sql", "c7a560523b281172fb0824fbc8f44e5ace2a3d46"),
            Map.entry("V32__user_notification_preferences.sql", "75a2a4ba005cfd55ad1a2c872a7ab7976673c7f8"),
            Map.entry("V33__action_item_assignment_events.sql", "2fa2a98a74ee8ec0da2adb6daa0e2057d5b647de"),
            Map.entry("V34__action_item_assignment_revocations.sql", "75ebcc7e793d5aff4fc254e72e8a5edcc30dc3ac"),
            Map.entry("V35__independent_diarization_stage.sql", "661530675fc8c62f91669b4b1609aae651d2686c"),
            Map.entry("V36__diarization_worker_boundary.sql", "fd93d2a7d971f567f88947ffa7fac817d2d5f578"),
            Map.entry("V37__diarization_acceptance_measurements.sql", "3751b258d35b3e5bcd7df6e38001f4992617f4df"),
            Map.entry("V38__diarization_verified_only_monitoring.sql", "6ecbd1b2b17bf7b96c957c4c44d082d5d0770898"),
            Map.entry("V39__bounded_verified_only_classification.sql", "caf43d7c294376b4d8b5c131a69a51e00c652991"),
            Map.entry("V40__meeting_export_persistence_and_fencing.sql", "dcf08ed0ae35ae624ded9a1e1ac5f550503af139"),
            Map.entry("V41__export_intake_source_provenance.sql", "5a4fdbd1cb071951c6bd8e491a5cf64143d84386"),
            Map.entry("V42__export_orphan_observation_ledger.sql", "974c88c550c017973d398e08111f26f5dd2188ce"),
            Map.entry("V43__export_schema_scoped_trigger_guards.sql", "32e3fc7fdc2c09f8d13c048c4b61b421c845438a")
    );

    @Test
    void flywayHistoryV1ThroughV43IsByteIdenticalAndEveryVersionIsUnique()
            throws IOException, NoSuchAlgorithmException {
        var resolver = new PathMatchingResourcePatternResolver();
        var actual = new TreeMap<String, String>();
        var versions = new HashMap<Integer, String>();
        for (var resource : resolver.getResources("classpath*:db/migration/V*__*.sql")) {
            String name = resource.getFilename();
            assertThat(name).as("Every migration must have a filename").isNotNull();
            var parsed = VERSION.matcher(name);
            assertThat(parsed.matches()).as("Canonical Flyway filename %s", name).isTrue();
            int version = Integer.parseInt(parsed.group(1));
            assertThat(versions.putIfAbsent(version, name))
                    .as("Duplicate Flyway version %s", version).isNull();
            assertThat(actual.putIfAbsent(name, gitBlobSha(resource.getInputStream().readAllBytes())))
                    .as("Duplicate migration resource %s", name).isNull();
        }
        assertThat(actual).as("Every frozen historical SQL file must match its original Git blob")
                .containsAllEntriesOf(FROZEN_SQL_BLOBS);
        for (int i = 1; i <= 43; i++) {
            assertThat(versions).as("Canonical migration V%s must be available", i)
                    .containsKey(i);
        }
        assertThat(actual).containsKey("V44__export_insert_lifecycle_guard.sql");
        assertThat(versions).containsKey(44);
    }

    @Test
    void productionConfigRemainsFailClosedUntilIndependentOperatorApproval()
            throws IOException {
        var production = new Properties();
        try (var input = getClass().getClassLoader()
                .getResourceAsStream("application.properties")) {
            assertThat(input).isNotNull();
            production.load(input);
        }
        Map<String, String> switches = Map.ofEntries(
            Map.entry("app.exports.public-admission-enabled", "APP_EXPORTS_PUBLIC_ADMISSION_ENABLED"),
            Map.entry("app.exports.worker.enabled", "APP_EXPORTS_WORKER_ENABLED"),
            Map.entry("app.exports.reconciliation.enabled", "APP_EXPORTS_RECONCILIATION_ENABLED"),
            Map.entry("app.exports.reconciliation.purge-enabled", "APP_EXPORTS_RECONCILIATION_PURGE_ENABLED"),
            Map.entry("app.media.processing.diarization-enabled", "APP_MEDIA_PROCESSING_DIARIZATION_ENABLED"),
            Map.entry("app.worker.diarization.enabled", "APP_WORKER_DIARIZATION_ENABLED"),
            Map.entry("app.worker.diarization.infrastructure-verified", "APP_WORKER_DIARIZATION_INFRASTRUCTURE_VERIFIED"),
            Map.entry("app.monitoring.private.enabled", "APP_MONITORING_PRIVATE_ENABLED")
        );
        switches.forEach((name, environment) ->
                assertThat(production.getProperty(name)).as(name)
                        .isEqualTo("${" + environment + ":false}"));
        assertThat(production.getProperty("management.endpoints.web.exposure.include"))
                .isEqualTo("health");
        assertThat(production.getProperty("management.endpoint.prometheus.access"))
                .isEqualTo("none");
        assertThat(production.getProperty("management.endpoint.metrics.access"))
                .isEqualTo("none");
        assertThat(production.getProperty("springdoc.api-docs.enabled"))
                .isEqualTo("false");
        assertThat(production.getProperty("springdoc.swagger-ui.enabled"))
                .isEqualTo("false");
    }

    /** Compute Git's object ID directly over the byte stream copied to classpath. */
    private static String gitBlobSha(byte[] content) throws NoSuchAlgorithmException {
        byte[] header = ("blob " + content.length + (char) 0)
                .getBytes(StandardCharsets.UTF_8);
        var sha = MessageDigest.getInstance("SHA-1");
        sha.update(header);
        sha.update(content);
        return HexFormat.of().formatHex(sha.digest());
    }
}
