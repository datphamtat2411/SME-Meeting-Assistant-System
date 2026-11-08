package com.sme.meetingassistant.api.media.storage;

import static org.assertj.core.api.Assertions.assertThat;

import com.sme.meetingassistant.api.media.MediaProperties;
import java.io.IOException;
import java.util.Map;
import java.util.Properties;
import org.junit.jupiter.api.Test;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.boot.context.properties.bind.Bindable;
import org.springframework.boot.context.properties.source.MapConfigurationPropertySource;

/** Shared configuration must expose both module switches without enabling either. */
class StorageConfigurationContractTests {

    @Test
    void productionPropertiesExposeDedicatedHttpsSigningOriginAndFailClosedSwitches()
            throws IOException {
        Properties defaults = new Properties();
        try (var stream = getClass().getClassLoader()
                .getResourceAsStream("application.properties")) {
            assertThat(stream).isNotNull();
            defaults.load(stream);
        }
        assertThat(defaults.getProperty("app.media.storage.public-download-endpoint"))
                .isEqualTo("${APP_MEDIA_STORAGE_PUBLIC_DOWNLOAD_ENDPOINT:}");
        assertThat(defaults.getProperty("app.media.processing.diarization-enabled"))
                .isEqualTo("${APP_MEDIA_PROCESSING_DIARIZATION_ENABLED:false}");
        assertThat(defaults.getProperty("app.exports.public-admission-enabled"))
                .isEqualTo("${APP_EXPORTS_PUBLIC_ADMISSION_ENABLED:false}");
        assertThat(defaults.getProperty("app.exports.worker.enabled"))
                .isEqualTo("${APP_EXPORTS_WORKER_ENABLED:false}");
        assertThat(defaults.getProperty("app.exports.reconciliation.enabled"))
                .isEqualTo("${APP_EXPORTS_RECONCILIATION_ENABLED:false}");
        assertThat(defaults.getProperty("app.exports.reconciliation.purge-enabled"))
                .isEqualTo("${APP_EXPORTS_RECONCILIATION_PURGE_ENABLED:false}");
        assertThat(defaults.getProperty("management.endpoint.prometheus.access"))
                .isEqualTo("none");
        assertThat(defaults.getProperty("management.endpoint.metrics.access"))
                .isEqualTo("none");
    }

    @Test
    void springBinderPreservesIndependentExportOriginAndDiarizationProperties() {
        var source = new MapConfigurationPropertySource(Map.of(
                "app.media.storage.public-download-endpoint", "https://downloads.example.invalid",
                "app.media.processing.diarization-enabled", "true",
                "app.media.outbox.diarization-routing-key", "processing.diarization.requested"));
        MediaProperties properties = new Binder(source)
                .bind("app.media", Bindable.of(MediaProperties.class)).orElseThrow();
        assertThat(properties.getStorage().getPublicDownloadEndpoint())
                .isEqualTo("https://downloads.example.invalid");
        assertThat(properties.getProcessing().isDiarizationEnabled()).isTrue();
        assertThat(properties.getOutbox().getDiarizationRoutingKey())
                .isEqualTo("processing.diarization.requested");
    }
}
