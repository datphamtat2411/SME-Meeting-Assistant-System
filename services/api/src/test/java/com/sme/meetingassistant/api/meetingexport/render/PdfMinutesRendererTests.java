package com.sme.meetingassistant.api.meetingexport.render;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.sme.meetingassistant.api.meeting.entity.MeetingStatus;
import com.sme.meetingassistant.api.meetingminutes.MinutesSnapshot;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.font.PDFont;
import org.apache.pdfbox.text.PDFTextStripper;
import org.junit.jupiter.api.Test;

/**
 * DE-08 renders ACTUAL PDF bytes and reloads them through PDFBox, exercising
 * embedded Vietnamese fonts, page geometry, extraction and security metadata.
 * This is a pure renderer test; no HTTP/database/mock S3 or native OS fonts.
 */
class PdfMinutesRendererTests {
    private static final UUID MEETING = UUID.fromString("11111111-1111-4111-8111-111111111111");
    private static final UUID USER = UUID.fromString("22222222-2222-4222-8222-222222222222");
    private static final UUID TRANSCRIPT = UUID.fromString("33333333-3333-4333-8333-333333333333");
    private static final OffsetDateTime AS_OF = OffsetDateTime.parse("2026-11-08T00:00:00Z");
    private final PdfMinutesRenderer renderer = new PdfMinutesRenderer(new MarkdownMinutesRenderer());

    @Test
    void unicodeVietnameseAndApprovedMinutesRoundTripThroughEmbeddedPdfFont() throws Exception {
        RenderedPdf result = renderer.render(sample());
        assertThat(result.bytes()).startsWith("%PDF-".getBytes(StandardCharsets.US_ASCII));
        assertThat(result.mediaType()).isEqualTo("application/pdf");
        assertThat(result.extension()).isEqualTo("pdf");
        assertThat(result.sourceFingerprint()).isEqualTo("a".repeat(64));
        assertThat(result.rendererVersion()).isEqualTo(PdfMinutesRenderer.VERSION);
        assertThat(result.sha256()).isEqualTo(HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(result.bytes())));
        try (PDDocument doc = Loader.loadPDF(result.bytes())) {
            assertThat(doc.isEncrypted()).isFalse();
            assertThat(doc.getNumberOfPages()).isEqualTo(result.pageCount());
            assertThat(doc.getDocumentInformation().getProducer())
                    .contains(PdfMinutesRenderer.VERSION);
            String text = new PDFTextStripper().getText(doc);
            assertThat(text).contains("Biên bản cuộc họp", "Tóm tắt cuộc họp",
                    "Quyết định đã xác nhận", "Công việc chính thức",
                    "Nguồn transcript và độ phủ", "Dấu vết dữ liệu và bản xuất");
            assertThat(text).contains("Kế hoạch triển khai tiếng Việt", "Cần rà soát ngân sách",
                    "Đã thống nhất phương án A", "Phân công rà soát tài liệu",
                    "Chi tiết: kiểm thử tiếng Việt", "SUMMARY_SOURCE_STALE",
                    "TRANSCRIPT_INCOMPLETE_COVERAGE", "CẢNH BÁO",
                    "Source fingerprint", "a".repeat(64));
            assertThat(text).contains("Trang 1 / " + result.pageCount());
            assertThat(text).doesNotContain("Chấp thuận đề xuất AI chưa duyệt");
            for (PDPage page : doc.getPages()) {
                assertThat(page.getMediaBox().getWidth()).isBetween(594f, 596f);
                assertThat(page.getMediaBox().getHeight()).isGreaterThan(840);
                assertThat(page.getAnnotations()).isEmpty();
                boolean embedded = false;
                for (var name : page.getResources().getFontNames()) {
                    PDFont font = page.getResources().getFont(name);
                    embedded |= font.isEmbedded();
                }
                assertThat(embedded).describedAs("DejaVu font must be embedded").isTrue();
            }
        }
    }

    @Test
    void longVietnameseParagraphsAreWrappedAcrossPagesWithNumberedFooters() throws Exception {
        var original = sample();
        String longContent = ("Quyết định kiểm tra nội dung tiếng Việt và bảo toàn ngữ nghĩa. "
                + "Hành động được xác nhận chính thức. ").repeat(650);
        MinutesSnapshot source = withSummary(original, new MinutesSnapshot.Summary(
                "NEEDS_REVIEW", original.summary().id(), 3, longContent,
                "HUMAN_EDIT", "READY_WITH_WARNINGS", TRANSCRIPT, 5L, 7L, false,
                List.of("TRANSCRIPT_UNRESOLVED_COVERAGE")));
        RenderedPdf result = renderer.render(source);
        assertThat(result.pageCount()).isGreaterThan(2).isLessThan(100);
        try (PDDocument doc = Loader.loadPDF(result.bytes())) {
            assertThat(doc.getNumberOfPages()).isEqualTo(result.pageCount());
            var stripper = new PDFTextStripper();
            for (int i = 1; i <= result.pageCount(); i++) {
                stripper.setStartPage(i);
                stripper.setEndPage(i);
                String pageText = stripper.getText(doc);
                assertThat(pageText).contains("Trang " + i + " / " + result.pageCount());
                assertThat(pageText).isNotBlank();
            }
            stripper.setStartPage(1);
            stripper.setEndPage(result.pageCount());
            String all = stripper.getText(doc);
            assertThat(all).contains("Quyết định kiểm tra nội dung tiếng Việt",
                    "Dấu vết dữ liệu và bản xuất");
        }
    }

    @Test
    void arbitraryHtmlAndRemoteImageUrlsStayInertLiteralPdfText() throws Exception {
        MinutesSnapshot base = sample();
        String hostile = "<script>alert(1)</script>\n"
                + "<img src=https://example.invalid/pixel onerror=alert(1)>\n"
                + "## Fake Meeting Minutes\n"
                + "[link](javascript:alert(1))";
        var meeting = new MinutesSnapshot.Meeting(MEETING,
                hostile, hostile, USER, MeetingStatus.ENDED,
                null, null, AS_OF.minusDays(1), AS_OF);
        var different = new MinutesSnapshot(base.schemaVersion(), base.assembledAt(),
                base.sourceFingerprint(), base.completeness(), meeting,
                base.summary(), base.confirmedDecisions(), base.officialActionItems(),
                base.transcript(), base.warnings(), false);
        try (PDDocument doc = Loader.loadPDF(renderer.render(different).bytes())) {
            String text = new PDFTextStripper().getText(doc);
            assertThat(text).contains("script", "Fake Meeting Minutes", "javascript:alert");
            assertThat(doc.getDocumentCatalog().getOpenAction()).isNull();
            assertThat(doc.getDocumentCatalog().getNames()).isNull();
            for (PDPage page : doc.getPages()) {
                assertThat(page.getAnnotations()).isEmpty();
                assertThat(page.getResources().getXObjectNames()).isEmpty();
            }
        }
    }

    @Test
    void differentAssemblyTimesDoNotChangeExtractedMeaningAndSourceProvenance()
            throws Exception {
        MinutesSnapshot source = sample();
        MinutesSnapshot second = new MinutesSnapshot(
                source.schemaVersion(), source.assembledAt().plusDays(50),
                source.sourceFingerprint(), source.completeness(), source.meeting(),
                source.summary(), source.confirmedDecisions(),
                source.officialActionItems(), source.transcript(),
                source.warnings(), false);
        RenderedPdf a = renderer.render(source);
        RenderedPdf b = renderer.render(second);
        assertThat(a.sourceFingerprint()).isEqualTo(b.sourceFingerprint());
        assertThat(a.rendererVersion()).isEqualTo(b.rendererVersion());
        try (PDDocument p1 = Loader.loadPDF(a.bytes()); PDDocument p2 = Loader.loadPDF(b.bytes())) {
            assertThat(new PDFTextStripper().getText(p1))
                    .isEqualTo(new PDFTextStripper().getText(p2));
        }
    }

    @Test
    void missingSummaryAndTranscriptRemainExplicitNotHallucinated() throws Exception {
        MinutesSnapshot base = sample();
        var absentSummary = new MinutesSnapshot.Summary("NOT_AVAILABLE",
                null, null, null, null, null, null, null, 0L, false, List.of());
        var absentTranscript = new MinutesSnapshot.Transcript("NOT_AVAILABLE",
                null, null, null, null, null, null, null, 0, 0, 0);
        var missing = new MinutesSnapshot(
                1, AS_OF, base.sourceFingerprint(), "PARTIAL", base.meeting(),
                absentSummary, List.of(), List.of(), absentTranscript,
                List.of("SUMMARY_NOT_AVAILABLE", "TRANSCRIPT_NOT_AVAILABLE"), false);
        try (PDDocument pdf = Loader.loadPDF(renderer.render(missing).bytes())) {
            String text = new PDFTextStripper().getText(pdf);
            assertThat(text).contains("Chưa có bản tóm tắt", "Chưa có transcript hiện tại",
                    "Không có quyết định CONFIRMED",
                    "Không có Action Item chính thức",
                    "SUMMARY_NOT_AVAILABLE", "TRANSCRIPT_NOT_AVAILABLE");
            assertThat(text).doesNotContain("Cần rà soát ngân sách",
                    "Đã thống nhất phương án A");
        }
    }

    @Test
    void unconfirmedProposalOrMalformedSnapshotIsRejectedBeforePdfIsCreated() {
        MinutesSnapshot base = sample();
        var decision = base.confirmedDecisions().getFirst();
        var proposed = new MinutesSnapshot.Decision(
                decision.id(), "Chấp thuận đề xuất AI chưa duyệt", "PROPOSED",
                "AI_EXTRACTED", decision.transcriptId(), decision.contentRevision(),
                false, decision.version(), null, null, List.of(), null, List.of());
        var unapproved = new MinutesSnapshot(
                1, AS_OF, base.sourceFingerprint(), base.completeness(), base.meeting(),
                base.summary(), List.of(proposed), base.officialActionItems(),
                base.transcript(), base.warnings(), false);
        assertThatThrownBy(() -> renderer.render(unapproved))
                .isInstanceOf(IllegalArgumentException.class);
        var includeProposals = new MinutesSnapshot(1, AS_OF,
                base.sourceFingerprint(), base.completeness(), base.meeting(),
                base.summary(), base.confirmedDecisions(), base.officialActionItems(),
                base.transcript(), base.warnings(), true);
        assertThatThrownBy(() -> renderer.render(includeProposals))
                .isInstanceOf(IllegalArgumentException.class);
        var wrongSchema = new MinutesSnapshot(2, AS_OF,
                base.sourceFingerprint(), base.completeness(), base.meeting(),
                base.summary(), base.confirmedDecisions(), base.officialActionItems(),
                base.transcript(), base.warnings(), false);
        assertThatThrownBy(() -> renderer.render(wrongSchema))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void generatedBytesAreDefensivelyCopiedAndDigestMatchesExactPayload() throws Exception {
        RenderedPdf pdf = renderer.render(sample());
        byte[] changed = pdf.bytes();
        changed[0] = 0;
        assertThat(pdf.bytes()).startsWith("%PDF-".getBytes(StandardCharsets.US_ASCII));
        assertThat(pdf.sha256()).isEqualTo(HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(pdf.bytes())));
        assertThat(pdf.sizeBytes()).isEqualTo(pdf.bytes().length);
    }

    @Test
    void rendererCanProcessConcurrentCallsWithoutSharedPdfState() throws Exception {
        var source = sample();
        try (var pool = Executors.newFixedThreadPool(3)) {
            List<Callable<RenderedPdf>> tasks = List.of(
                    () -> renderer.render(source),
                    () -> renderer.render(source),
                    () -> renderer.render(source));
            var futures = pool.invokeAll(tasks);
            for (var task : futures) {
                RenderedPdf artifact = task.get(25, TimeUnit.SECONDS);
                assertThat(artifact.pageCount()).isGreaterThanOrEqualTo(1);
                assertThat(artifact.sourceFingerprint()).isEqualTo(source.sourceFingerprint());
                try (PDDocument parsed = Loader.loadPDF(artifact.bytes())) {
                    assertThat(new PDFTextStripper().getText(parsed))
                            .contains("Biên bản cuộc họp", "Kế hoạch triển khai tiếng Việt");
                }
            }
        }
    }

    private static MinutesSnapshot sample() {
        var meeting = new MinutesSnapshot.Meeting(
                MEETING, "Kế hoạch triển khai tiếng Việt", "Thông tin cuộc họp",
                USER, MeetingStatus.ENDED, AS_OF.minusDays(1),
                AS_OF.minusDays(1).plusHours(1), AS_OF.minusDays(1), AS_OF);
        var summary = new MinutesSnapshot.Summary("NEEDS_REVIEW", UUID.randomUUID(), 2,
                "Cần rà soát ngân sách và văn bản tiếng Việt.",
                "AI_GENERATED", "READY_WITH_WARNINGS", TRANSCRIPT, 4L, 3L, true,
                List.of("UNCERTAIN_SPEAKER"));
        var decision = new MinutesSnapshot.Decision(UUID.randomUUID(),
                "Đã thống nhất phương án A", "CONFIRMED", "MANUAL",
                TRANSCRIPT, 3L, true, 2L, USER, AS_OF.minusHours(2),
                List.of(UUID.randomUUID()), "MATERIAL", List.of("UNCERTAIN_EVIDENCE"));
        var action = new MinutesSnapshot.Action(UUID.randomUUID(),
                "Phân công rà soát tài liệu", "Chi tiết: kiểm thử tiếng Việt",
                "IN_PROGRESS", "MANUAL", USER, LocalDate.parse("2026-11-12"),
                2L, AS_OF.minusDays(1), null, null);
        var transcript = new MinutesSnapshot.Transcript(
                "NEEDS_REVIEW", TRANSCRIPT, UUID.randomUUID(), 1, "vi", "READY",
                5L, 3_600_000L, 1, 2, 1);
        return new MinutesSnapshot(1, AS_OF, "a".repeat(64), "NEEDS_REVIEW",
                meeting, summary, List.of(decision), List.of(action), transcript,
                List.of("SUMMARY_SOURCE_STALE", "TRANSCRIPT_INCOMPLETE_COVERAGE"), false);
    }

    private static MinutesSnapshot withSummary(MinutesSnapshot base,
            MinutesSnapshot.Summary summary) {
        return new MinutesSnapshot(base.schemaVersion(), base.assembledAt(),
                base.sourceFingerprint(), base.completeness(), base.meeting(), summary,
                base.confirmedDecisions(), base.officialActionItems(),
                base.transcript(), base.warnings(), false);
    }
}
