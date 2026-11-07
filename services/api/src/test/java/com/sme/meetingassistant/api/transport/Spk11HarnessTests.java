package com.sme.meetingassistant.api.transport;

import static org.assertj.core.api.Assertions.*;

import java.io.StringReader;
import java.nio.file.*;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class Spk11HarnessTests {
    @TempDir Path directory;

    @Test void audioRootIsCreatedPrivatelyBeforeWorkersAndCannotReuseAnExistingPath() throws Exception {
        Path audio=Spk11Infrastructure.prepareAudioDirectory(directory);
        assertThat(Files.isDirectory(audio,LinkOption.NOFOLLOW_LINKS)).isTrue();
        assertThat(Files.isSymbolicLink(audio)).isFalse();
        assertThat(Files.getOwner(audio,LinkOption.NOFOLLOW_LINKS)).isEqualTo(Files.getOwner(directory));
        assertThat(Files.getPosixFilePermissions(audio)).isEqualTo(PosixFilePermissions.fromString("rwx------"));
        assertThatThrownBy(()->Spk11Infrastructure.prepareAudioDirectory(directory)).isInstanceOf(FileAlreadyExistsException.class);
    }

    @Test void audioRootCannotFollowAPreexistingSymlink() throws Exception {
        Path target=Files.createDirectory(directory.resolve("other"));
        Files.createSymbolicLink(directory.resolve("audio"),target);
        assertThatThrownBy(()->Spk11Infrastructure.prepareAudioDirectory(directory)).isInstanceOf(FileAlreadyExistsException.class);
        try(var children=Files.list(target)) {assertThat(children).isEmpty();}
    }

    @Test void controlledFailureReportsOnlyAllowlistedPhaseAndCategory() {
        assertThatThrownBy(()->Spk11FullStackSmokeTests.WorkerProcess.decode(
            "{\"failure\":\"SPK11_WORKER_PROCESS_FAILED\",\"phase\":\"TEMP_STORAGE\",\"category\":\"RESOURCE\"}"))
            .isInstanceOf(AssertionError.class)
            .hasMessage("SPK11_WORKER_PROCESS_FAILED phase=TEMP_STORAGE category=RESOURCE");
    }

    @Test void malformedAndUntrustedDiagnosticsNeverEnterFailureMessages() {
        for(String line:new String[]{"SECRET transcript", "{\"checkpoint\":\"SECRET\"}",
            "{\"failure\":\"SECRET\",\"phase\":\"TEMP_STORAGE\",\"category\":\"RESOURCE\"}",
            "{\"failure\":\"SPK11_WORKER_PROCESS_FAILED\",\"phase\":\"SECRET\",\"category\":\"RESOURCE\"}",
            "{\"failure\":\"SPK11_WORKER_PROCESS_FAILED\",\"phase\":\"TEMP_STORAGE\",\"category\":\"SECRET\"}",
            "{\"checkpoint\":\"finished\",\"claims\":\"SECRET\"}"}) {
            assertThatThrownBy(()->Spk11FullStackSmokeTests.WorkerProcess.decode(line))
                .isInstanceOf(AssertionError.class).hasMessage("SPK11_WORKER_PROTOCOL_INVALID");
        }
    }

    @Test void protocolReadIsBoundedAndSuccessCheckpointIsUnchanged() throws Exception {
        assertThatThrownBy(()->Spk11FullStackSmokeTests.WorkerProcess.readEnvelope(new StringReader("S".repeat(4097))))
            .isInstanceOf(AssertionError.class).hasMessage("SPK11_WORKER_PROTOCOL_INVALID");
        assertThat(Spk11FullStackSmokeTests.WorkerProcess.decode("{\"checkpoint\":\"inference\"}").path("checkpoint").asText())
            .isEqualTo("inference");
        assertThat(Spk11FullStackSmokeTests.WorkerProcess.decode(
            "{\"checkpoint\":\"finished\",\"claims\":1,\"completes\":1,\"failures\":0,\"acks\":1,\"uploads\":1,\"predictions\":1,\"lookups\":1,\"core_errors\":0,\"core_status\":0,\"rejects\":0,\"backoffs\":[]}")
            .path("acks").asInt()).isEqualTo(1);
    }

    @Test void unexpectedExitReportsNumericStatusAndDiscardsUncontrolledStderr() throws Exception {
        // Test the subprocess protocol without requiring the optional AI virtualenv.
        try(var process=new Spk11FullStackSmokeTests.WorkerProcess(Map.of(),"/bin/sh","-c",
            "IFS= read -r ignored; printf '%s' 'SECRET credentials transcript' >&2; exit 7")) {
            assertThatThrownBy(process::next).isInstanceOf(AssertionError.class)
                .hasMessage("SPK11_WORKER_EXIT_WITHOUT_ENVELOPE exitCode=7");
        }
    }
}
