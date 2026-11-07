package com.sme.meetingassistant.api.meetingexport.render;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.sme.meetingassistant.api.meeting.entity.MeetingStatus;
import com.sme.meetingassistant.api.meetingminutes.MinutesSnapshot;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.HexFormat;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * DE-07 focused renderer contract. Pure tests: no source queries, AI inference,
 * S3 calls, HTTP session or a second Minutes state machine.
 */
class MarkdownMinutesRendererTests {
    private static final MarkdownMinutesRenderer RENDERER = new MarkdownMinutesRenderer();
    private static final UUID MEETING_ID = UUID.fromString("11111111-1111-4111-8111-111111111111");
    private static final UUID ORGANIZER = UUID.fromString("22222222-2222-4222-8222-222222222222");
    private static final UUID TRANSCRIPT_ID = UUID.fromString("33333333-3333-4333-8333-333333333333");
    private static final UUID SOURCE_ID = UUID.fromString("44444444-4444-4444-8444-444444444444");
    private static final UUID DECISION_ID = UUID.fromString("55555555-5555-4555-8555-555555555555");
    private static final UUID ACTION_ID = UUID.fromString("66666666-6666-4666-8666-666666666666");
    private static final OffsetDateTime NOW = OffsetDateTime.parse("2026-11-07T12:00:00Z");

    @Test
    void rendersVietnameseUnicodeOfficialContentAndAllSourceProvenanceInStableSections()
            throws Exception {
        MinutesSnapshot source = sample();
        RenderedMarkdown rendered = RENDERER.render(source);
        String text = rendered.text();

        assertThat(text).startsWith("# Biên bản cuộc họp\n\n");
        assertThat(text).contains("Kế hoạch ra mắt 🎯", "Thảo luận: triển khai tính năng mới",
                "Quyết định đã xác nhận (1)", "Công việc chính thức (1)",
                "Tóm tắt cuộc họp", "Nguồn transcript và độ phủ",
                "Dấu vết dữ liệu và bản xuất");
        assertThat(text.indexOf("Mức độ đầy đủ và cảnh báo"))
                .isLessThan(text.indexOf("Tóm tắt cuộc họp"));
        assertThat(text.indexOf("Tóm tắt cuộc họp"))
                .isLessThan(text.indexOf("Quyết định đã xác nhận"));
        assertThat(text.indexOf("Quyết định đã xác nhận"))
                .isLessThan(text.indexOf("Công việc chính thức"));
        assertThat(text).contains("Cần rà soát ngân sách", "Đã thống nhất phương án A",
                "Chuẩn bị báo cáo thử nghiệm", "Chi tiết công việc tiếng Việt",
                "Evidence segment (ID)", "Nguồn lỗi thời", "Lần chọn phiên bản",
                "Content revision", "Độ không chắc chắn AI", "Vùng chưa đủ coverage");
        // Canonical UUIDs remain readable in rendered Markdown, while the
        // source escapes hyphens in the UTF-8 Markdown representation.
        assertThat(text).contains(SOURCE_ID.toString().replace("-", "\\-"),
                TRANSCRIPT_ID.toString().replace("-", "\\-"),
                DECISION_ID.toString().replace("-", "\\-"),
                ACTION_ID.toString().replace("-", "\\-"));
        assertThat(text).contains("SUMMARY_SOURCE_STALE".replace("_", "\\_"),
                "TRANSCRIPT_INCOMPLETE_COVERAGE".replace("_", "\\_"));
        assertThat(text).contains("CẢNH BÁO NGUỒN", "CẢNH BÁO:", "NEEDS_REVIEW".replace("_", "\\_"));
        assertThat(text).contains("Source fingerprint (SHA-256)", "a".repeat(64),
                MarkdownMinutesRenderer.VERSION.replace("-", "\\-"));
        assertThat(text).doesNotContain("\r", "\uFEFF", "2026-11-07T12:00:00Z\n\n## Dấu");
        assertThat(rendered.sizeBytes()).isEqualTo(rendered.utf8().length);
        assertThat(rendered.mediaType()).isEqualTo("text/markdown; charset=UTF-8");
        assertThat(rendered.extension()).isEqualTo("md");
        assertThat(rendered.sha256()).isEqualTo(HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(rendered.utf8())));
        assertThat(new String(rendered.utf8(), StandardCharsets.UTF_8)).isEqualTo(text);
    }

    @Test
    void identicalCanonicalContentWithDifferentAssemblyTimeHasExactlySameUtf8AndDigest() {
        MinutesSnapshot first = sample();
        MinutesSnapshot nextRead = new MinutesSnapshot(first.schemaVersion(),
                first.assembledAt().plusDays(7), first.sourceFingerprint(),
                first.completeness(), first.meeting(), first.summary(),
                first.confirmedDecisions(), first.officialActionItems(),
                first.transcript(), first.warnings(), first.proposalsIncluded());
        RenderedMarkdown a = RENDERER.render(first);
        RenderedMarkdown b = RENDERER.render(nextRead);
        assertThat(a.utf8()).isEqualTo(b.utf8());
        assertThat(a.sha256()).isEqualTo(b.sha256());
        assertThat(a.rendererVersion()).isEqualTo("markdown-v1");
        assertThat(a.sourceFingerprint()).isEqualTo("a".repeat(64));
        assertThat(a.text()).doesNotContain("2026-11-14T12:00:00Z");
    }

    @Test
    void hostileTitleSummaryAndActionDetailsCannotInjectHtmlHeadingsLinksOrImages() {
        String malicious = "# Fake heading\r\n<script>alert('x')</script>\n"
                + "<img src=x onerror=alert(1)>\n"
                + "[độc hại](javascript:alert(1))\n"
                + "![](https://evil.example/pixel)\n"
                + "|X|Y|\n"
                + "### Approved\n"
                + "\u0060\u0060\u0060java\nSystem.exit(0);\n\u0060\u0060\u0060";
        MinutesSnapshot base = sample();
        var meeting = new MinutesSnapshot.Meeting(base.meeting().id(), malicious,
                base.meeting().description(), base.meeting().organizerUserId(),
                base.meeting().status(), base.meeting().scheduledStartAt(),
                base.meeting().scheduledEndAt(), base.meeting().startedAt(),
                base.meeting().endedAt());
        var summary = new MinutesSnapshot.Summary(base.summary().availability(),
                base.summary().id(), base.summary().versionNumber(),
                malicious, base.summary().sourceType(), base.summary().qualityStatus(),
                base.summary().transcriptId(), base.summary().contentRevision(),
                base.summary().selectionEpoch(), base.summary().isStale(),
                base.summary().aiWarnings());
        var a = base.officialActionItems().getFirst();
        var action = new MinutesSnapshot.Action(a.id(), malicious, malicious, a.status(),
                a.sourceType(), a.assigneeUserId(), a.dueDate(), a.version(),
                a.createdAt(), a.confirmedByUserId(), a.confirmedAt());
        MinutesSnapshot adversarial = replace(base, meeting, summary,
                base.confirmedDecisions(), List.of(action), base.transcript(), base.warnings(),
                false, 1);
        String text = RENDERER.render(adversarial).text();

        assertThat(text).contains("> \\# Fake heading",
                "> &lt;script&gt;alert\\('x'\\)&lt;/script&gt;",
                "> \\[độc hại\\]\\(javascript:alert\\(1\\)\\)",
                "> \\!\\[\\]\\(https://evil\\.example/pixel\\)",
                "> \\|X\\|Y\\|", "> \\#\\#\\# Approved");
        assertThat(text).doesNotContain("<script", "<img", "](", "![](", "\r");
        assertThat(text).doesNotContain("\n## Fake heading", "\n### Approved");
        // Renderer-controlled headings are stable even with source line breaks.
        assertThat(text).contains("### Công việc 1");
    }

    @Test
    void suspiciousCoverageAndStaleWarningsRemainVisibleEvenWithApprovedDecision() {
        String text = RENDERER.render(sample()).text();
        assertThat(text).contains("TRANSCRIPT_INCOMPLETE_COVERAGE".replace("_", "\\_"),
                "SUMMARY_SOURCE_STALE".replace("_", "\\_"),
                "UNCERTAIN_EVIDENCE".replace("_", "\\_"));
        assertThat(text).contains("CẢNH BÁO NGUỒN", "Quyết định đã xác nhận (1)",
                "CẢNH BÁO:", "Đề xuất AI chưa được duyệt");
        assertThat(text).doesNotContain("Quyết định đề xuất được phê duyệt");
    }

    @Test
    void absenceIsExplicitAndDoesNotManufactureTranscriptOrSummaryText() {
        MinutesSnapshot source = sample();
        var summary = new MinutesSnapshot.Summary("NOT_AVAILABLE",
                null, null, null, null, null, null, null, 0, false, List.of());
        var transcript = new MinutesSnapshot.Transcript("NOT_AVAILABLE",
                null, null, null, null, null, null, null, 0, 0, 0);
        var missing = replace(source, source.meeting(), summary, List.of(), List.of(),
                transcript, List.of("TRANSCRIPT_NOT_AVAILABLE", "SUMMARY_NOT_AVAILABLE"),
                false, 1);
        String text = RENDERER.render(missing).text();
        assertThat(text).contains("Chưa có bản tóm tắt", "Chưa có transcript hiện tại",
                "Không có quyết định CONFIRMED", "Không có Action Item chính thức",
                "TRANSCRIPT_NOT_AVAILABLE".replace("_", "\\_"),
                "SUMMARY_NOT_AVAILABLE".replace("_", "\\_"));
        assertThat(text).doesNotContain("Cần rà soát ngân sách", "Đã thống nhất phương án A");
        assertThat(text).contains("Biên bản chưa được xác nhận");
    }

    @Test
    void rejectedOrUnconfirmedRecordsAreNeverSilentlyPromoted() {
        MinutesSnapshot base = sample();
        var d = base.confirmedDecisions().getFirst();
        var proposed = new MinutesSnapshot.Decision(d.id(), "AI đề xuất A", "PROPOSED",
                d.sourceType(), d.transcriptId(), d.contentRevision(), d.isStale(),
                d.version(), null, null, d.evidenceSegmentIds(),
                d.aiUncertainty(), d.aiWarnings());
        assertThatThrownBy(() -> RENDERER.render(replace(base, base.meeting(),
                base.summary(), List.of(proposed), base.officialActionItems(),
                base.transcript(), base.warnings(), false, 1)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Unconfirmed Decision");

        var a = base.officialActionItems().getFirst();
        var unreviewed = new MinutesSnapshot.Action(a.id(), "AI task", a.details(), "PROPOSED",
                "AI_EXTRACTED", a.assigneeUserId(), a.dueDate(), a.version(),
                a.createdAt(), null, null);
        assertThatThrownBy(() -> RENDERER.render(replace(base, base.meeting(),
                base.summary(), base.confirmedDecisions(), List.of(unreviewed),
                base.transcript(), base.warnings(), false, 1)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Unconfirmed Action Item");
        assertThatThrownBy(() -> RENDERER.render(replace(base, base.meeting(),
                base.summary(), base.confirmedDecisions(), base.officialActionItems(),
                base.transcript(), base.warnings(), true, 1)))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void unsupportedSchemaMalformedFingerprintAndInconsistentAvailabilityFailClosed() {
        MinutesSnapshot base = sample();
        assertThatThrownBy(() -> RENDERER.render(replace(base, base.meeting(),
                base.summary(), base.confirmedDecisions(), base.officialActionItems(),
                base.transcript(), base.warnings(), false, 2)))
                .isInstanceOf(IllegalArgumentException.class);
        var wrongDigest = new MinutesSnapshot(base.schemaVersion(), base.assembledAt(),
                "not-a-digest", base.completeness(), base.meeting(), base.summary(),
                base.confirmedDecisions(), base.officialActionItems(),
                base.transcript(), base.warnings(), false);
        assertThatThrownBy(() -> RENDERER.render(wrongDigest))
                .isInstanceOf(IllegalArgumentException.class);
        var s = base.summary();
        var broken = new MinutesSnapshot.Summary("AVAILABLE", null, s.versionNumber(),
                s.content(), s.sourceType(), s.qualityStatus(), s.transcriptId(),
                s.contentRevision(), s.selectionEpoch(), s.isStale(), s.aiWarnings());
        assertThatThrownBy(() -> RENDERER.render(replace(base, base.meeting(),
                broken, base.confirmedDecisions(), base.officialActionItems(),
                base.transcript(), base.warnings(), false, 1)))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void controlCharactersAndBidiOverridesAreNeutralizedWithoutRemovingVietnamese() {
        String hostile = "Nội dung\u001b[31m\u0000\u202eabc\u2067café \ud83c\udf1f";
        String safe = SafeMarkdownText.inline(hostile);
        assertThat(safe).contains("Nội dung", "café 🌟");
        assertThat(safe).doesNotContain("\u001b", "\u0000", "\u202e", "\u2067");
        assertThat(SafeMarkdownText.inline("A\r\nB\u2028C\u0085D"))
                .isEqualTo("A B C D");
        assertThat(SafeMarkdownText.inline("a&b <tag> | [url](x)"))
                .isEqualTo("a&amp;b &lt;tag&gt; \\| \\[url\\]\\(x\\)");
    }

    @Test
    void artifactBytesAreDefensivelyCopiedAndDigestDoesNotMutate() {
        RenderedMarkdown output = RENDERER.render(sample());
        String digest = output.sha256();
        byte[] first = output.utf8();
        first[0] = 0;
        byte[] second = output.utf8();
        assertThat(second[0]).isEqualTo((byte) '#');
        assertThat(output.sha256()).isEqualTo(digest);
        assertThat(output.text()).startsWith("# Biên bản cuộc họp");
    }

    @Test
    void inputSizeLimitsFailClosedRatherThanSilentlyTruncatingEvidence() {
        assertThatThrownBy(() -> SafeMarkdownText.inline("a".repeat(1_048_577)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("exceeds");
        MinutesSnapshot base = sample();
        var d = base.confirmedDecisions().getFirst();
        String longText = "x".repeat(980_000);
        var decisions = java.util.stream.IntStream.range(0, 10).mapToObj(i ->
                new MinutesSnapshot.Decision(UUID.randomUUID(), longText, "CONFIRMED",
                    d.sourceType(), d.transcriptId(), d.contentRevision(), d.isStale(),
                    d.version(), d.confirmedByUserId(), d.confirmedAt(),
                    d.evidenceSegmentIds(), d.aiUncertainty(), d.aiWarnings())).toList();
        assertThatThrownBy(() -> RENDERER.render(replace(base, base.meeting(),
                base.summary(), decisions, base.officialActionItems(), base.transcript(),
                base.warnings(), false, 1)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("8 MiB");
    }

    private static MinutesSnapshot sample() {
        var meeting = new MinutesSnapshot.Meeting(MEETING_ID, "Kế hoạch ra mắt 🎯",
                "Thảo luận: triển khai tính năng mới", ORGANIZER,
                MeetingStatus.ENDED, NOW.minusDays(1), NOW.minusDays(1).plusHours(1),
                NOW.minusDays(1), NOW.minusDays(1).plusHours(1));
        var summary = new MinutesSnapshot.Summary("NEEDS_REVIEW", SOURCE_ID, 2,
                "Cần rà soát ngân sách\nTriển khai tuần sau", "AI_GENERATED",
                "READY_WITH_WARNINGS", TRANSCRIPT_ID, 4L, 3L, true,
                List.of("UNCERTAIN_SPEAKER"));
        var decision = new MinutesSnapshot.Decision(DECISION_ID,
                "Đã thống nhất phương án A", "CONFIRMED", "AI_EXTRACTED",
                TRANSCRIPT_ID, 4L, true, 7L, ORGANIZER,
                NOW.minusHours(2), List.of(UUID.randomUUID()), "MATERIAL",
                List.of("UNCERTAIN_EVIDENCE"));
        var action = new MinutesSnapshot.Action(ACTION_ID, "Chuẩn bị báo cáo thử nghiệm",
                "Chi tiết công việc tiếng Việt", "IN_PROGRESS", "MANUAL",
                ORGANIZER, LocalDate.parse("2026-11-12"), 5L,
                NOW.minusDays(1), null, null);
        var transcript = new MinutesSnapshot.Transcript("NEEDS_REVIEW", TRANSCRIPT_ID,
                UUID.randomUUID(), 1, "vi", "READY", 5L, 3_600_000L, 2, 1, 1);
        return new MinutesSnapshot(1, NOW, "a".repeat(64), "NEEDS_REVIEW",
                meeting, summary, List.of(decision), List.of(action), transcript,
                List.of("SUMMARY_SOURCE_STALE", "TRANSCRIPT_INCOMPLETE_COVERAGE"),
                false);
    }

    private static MinutesSnapshot replace(MinutesSnapshot base,
            MinutesSnapshot.Meeting meeting, MinutesSnapshot.Summary summary,
            List<MinutesSnapshot.Decision> decisions, List<MinutesSnapshot.Action> actions,
            MinutesSnapshot.Transcript transcript, List<String> warnings,
            boolean proposalsIncluded, int schemaVersion) {
        return new MinutesSnapshot(schemaVersion, base.assembledAt(),
                base.sourceFingerprint(), base.completeness(), meeting, summary,
                decisions, actions, transcript, warnings, proposalsIncluded);
    }
}
