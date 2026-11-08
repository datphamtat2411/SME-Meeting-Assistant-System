package com.sme.meetingassistant.api.meetingexport.render;

import com.sme.meetingassistant.api.meetingminutes.MinutesSnapshot;
import java.nio.charset.StandardCharsets;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.stereotype.Service;

/**
 * DE-07: deterministic, read-only Markdown representation of the authorized,
 * immutable DE-05 MinutesSnapshot. No AI inference, source re-fetch, database
 * access, network, filesystem, S3 or authentication decisions are made here.
 *
 * Admission/authorization: DE-09. Private object proof/access: DE-10.
 * The input fingerprint is a provenance marker, NOT an access credential.
 */
@Service
public final class MarkdownMinutesRenderer {
    public static final String VERSION = "markdown-v1";
    private static final int SUPPORTED_SCHEMA = 1;
    private static final int MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
    private static final Pattern DIGEST = Pattern.compile("[0-9a-f]{64}");
    private static final Set<String> COMPLETENESS = Set.of("COMPLETE", "PARTIAL", "NEEDS_REVIEW");
    private static final Set<String> AVAILABILITY = Set.of(
            "AVAILABLE", "NOT_AVAILABLE", "PROCESSING", "FAILED", "NEEDS_REVIEW");
    private static final Set<String> OFFICIAL_ACTION_STATUSES = Set.of(
            "OPEN", "IN_PROGRESS", "DONE", "CANCELLED");

    public RenderedMarkdown render(MinutesSnapshot snapshot) {
        validate(snapshot);
        var out = new StringBuilder(8192);
        out.append("# Biên bản cuộc họp\n\n");
        out.append("**Đây là bản thể hiện của dữ liệu tại thời điểm chốt nguồn; ")
                .append("không thay thế dữ liệu nghiệp vụ gốc.**\n");

        section(out, "Thông tin cuộc họp");
        var meeting = snapshot.meeting();
        field(out, "Tiêu đề", meeting.title());
        field(out, "Mã cuộc họp", meeting.id());
        field(out, "Mô tả", meeting.description());
        field(out, "Người tổ chức (ID)", meeting.organizerUserId());
        field(out, "Trạng thái cuộc họp", meeting.status());
        field(out, "Bắt đầu dự kiến (UTC)", instant(meeting.scheduledStartAt()));
        field(out, "Kết thúc dự kiến (UTC)", instant(meeting.scheduledEndAt()));
        field(out, "Bắt đầu thực tế (UTC)", instant(meeting.startedAt()));
        field(out, "Kết thúc thực tế (UTC)", instant(meeting.endedAt()));

        section(out, "Mức độ đầy đủ và cảnh báo");
        field(out, "Mức độ đầy đủ", snapshot.completeness());
        out.append("- **Đề xuất AI chưa được duyệt:** Không bao gồm trong biên bản chính thức.\n");
        out.append("- **Ghi chú:** Trạng thái cuộc họp độc lập với trạng thái xử lý AI.\n");
        if (snapshot.warnings().isEmpty()) {
            out.append("- Không có cảnh báo nào được ghi nhận trong snapshot này.\n");
        } else {
            for (String warning : snapshot.warnings()) field(out, "Cảnh báo", warning);
        }
        if (!"COMPLETE".equals(snapshot.completeness())) {
            out.append("\n**CẢNH BÁO:** Biên bản chưa được xác nhận là đầy đủ. ")
                    .append("Không diễn giải các đoạn chưa rõ thành thông tin đã xác minh.\n");
        }

        section(out, "Tóm tắt cuộc họp");
        var summary = snapshot.summary();
        field(out, "Tình trạng nguồn", summary.availability());
        if (summary.id() == null || "NOT_AVAILABLE".equals(summary.availability())) {
            out.append("\n*Chưa có bản tóm tắt trong nguồn hiện tại.*\n");
        } else {
            field(out, "Mã phiên bản", summary.id());
            field(out, "Số phiên bản", summary.versionNumber());
            field(out, "Lần chọn phiên bản", summary.selectionEpoch());
            field(out, "Loại nguồn", summary.sourceType());
            field(out, "Chất lượng", summary.qualityStatus());
            field(out, "Transcript nguồn", summary.transcriptId());
            field(out, "Content revision", summary.contentRevision());
            field(out, "Nguồn lỗi thời", summary.isStale() ? "CÓ" : "KHÔNG");
            if (summary.isStale() || "NEEDS_REVIEW".equals(summary.availability())) {
                out.append("\n**CẢNH BÁO NGUỒN:** Tóm tắt có thể lỗi thời ")
                        .append("hoặc cần người dùng rà soát.\n");
            }
            out.append("\n");
            SafeMarkdownText.quote(out, summary.content());
            warningList(out, summary.aiWarnings(), "Cảnh báo tóm tắt");
        }

        section(out, "Quyết định đã xác nhận (" + snapshot.confirmedDecisions().size() + ")");
        if (snapshot.confirmedDecisions().isEmpty()) {
            out.append("Không có quyết định CONFIRMED trong nguồn hiện tại.\n");
        }
        int decisionNumber = 0;
        for (var decision : snapshot.confirmedDecisions()) {
            out.append("### Quyết định ").append(++decisionNumber).append("\n\n");
            SafeMarkdownText.quote(out, decision.content());
            field(out, "Mã quyết định", decision.id());
            field(out, "Trạng thái", decision.status());
            field(out, "Loại nguồn", decision.sourceType());
            field(out, "Phiên bản", decision.version());
            field(out, "Người xác nhận (ID)", decision.confirmedByUserId());
            field(out, "Xác nhận lúc (UTC)", instant(decision.confirmedAt()));
            field(out, "Transcript nguồn", decision.transcriptId());
            field(out, "Content revision", decision.contentRevision());
            field(out, "Nguồn lỗi thời", decision.isStale() ? "CÓ" : "KHÔNG");
            field(out, "Độ không chắc chắn AI", decision.aiUncertainty());
            for (UUID evidence : decision.evidenceSegmentIds()) {
                field(out, "Evidence segment (ID)", evidence);
            }
            if (decision.isStale() || "MATERIAL".equals(decision.aiUncertainty())
                    || !decision.aiWarnings().isEmpty()) {
                out.append("- **CẢNH BÁO:** Quyết định đã được xác nhận nhưng ")
                        .append("dấu vết nguồn hoặc evidence có thể cần kiểm tra lại.\n");
            }
            warningList(out, decision.aiWarnings(), "Cảnh báo evidence");
            out.append("\n");
        }

        section(out, "Công việc chính thức (" + snapshot.officialActionItems().size() + ")");
        if (snapshot.officialActionItems().isEmpty()) {
            out.append("Không có Action Item chính thức trong nguồn hiện tại.\n");
        }
        int actionNumber = 0;
        for (var action : snapshot.officialActionItems()) {
            out.append("### Công việc ").append(++actionNumber).append("\n\n");
            field(out, "Tiêu đề", action.title());
            field(out, "Mã công việc", action.id());
            field(out, "Trạng thái", action.status());
            field(out, "Loại nguồn", action.sourceType());
            field(out, "Người phụ trách (ID)", action.assigneeUserId());
            field(out, "Hạn (ngày)", action.dueDate());
            field(out, "Phiên bản", action.version());
            field(out, "Tạo lúc (UTC)", instant(action.createdAt()));
            field(out, "Người xác nhận (ID)", action.confirmedByUserId());
            field(out, "Xác nhận lúc (UTC)", instant(action.confirmedAt()));
            if (action.details() != null && !action.details().isBlank()) {
                out.append("\n**Chi tiết:**\n\n");
                SafeMarkdownText.quote(out, action.details());
            }
            out.append("\n");
        }

        section(out, "Nguồn transcript và độ phủ");
        var transcript = snapshot.transcript();
        field(out, "Tình trạng nguồn", transcript.availability());
        if (transcript.id() == null || "NOT_AVAILABLE".equals(transcript.availability())) {
            out.append("\n*Chưa có transcript hiện tại; không tạo phát biểu thay thế.*\n");
        } else {
            field(out, "Transcript ID", transcript.id());
            field(out, "Processing job ID", transcript.processingJobId());
            field(out, "Phiên bản", transcript.versionNumber());
            field(out, "Ngôn ngữ", transcript.languageCode());
            field(out, "Trạng thái transcript", transcript.status());
            field(out, "Content revision", transcript.contentRevision());
            field(out, "Thời lượng (ms)", transcript.durationMs());
            field(out, "Đoạn đáng ngờ", transcript.suspiciousSegments());
            field(out, "Đoạn chưa giải quyết", transcript.unresolvedSegments());
            field(out, "Vùng chưa đủ coverage", transcript.unresolvedCoverageRegions());
            if (transcript.suspiciousSegments() > 0
                    || transcript.unresolvedSegments() > 0
                    || transcript.unresolvedCoverageRegions() > 0
                    || "NEEDS_REVIEW".equals(transcript.availability())) {
                out.append("\n**CẢNH BÁO:** Bản ghi có vùng âm thanh ")
                        .append("chưa rõ hoặc chất lượng cần được kiểm tra.\n");
            }
            out.append("\n*Chỉ chứa tham chiếu và tình trạng nguồn; ")
                    .append("không chép nguyên transcript vào bản xuất này.*\n");
        }

        section(out, "Dấu vết dữ liệu và bản xuất");
        field(out, "Snapshot schema version", snapshot.schemaVersion());
        field(out, "Source fingerprint (SHA-256)", snapshot.sourceFingerprint());
        field(out, "Phiên bản renderer", VERSION);
        out.append("\n*Bản Markdown được sinh từ một snapshot; ")
                .append("không phải nguồn sự thật nghiệp vụ mới.*\n");

        byte[] utf8 = out.toString().getBytes(StandardCharsets.UTF_8);
        if (utf8.length > MAX_DOCUMENT_BYTES) {
            throw new IllegalArgumentException("Rendered Markdown exceeds 8 MiB");
        }
        return new RenderedMarkdown(utf8, snapshot.sourceFingerprint(), VERSION);
    }

    private static void validate(MinutesSnapshot snapshot) {
        Objects.requireNonNull(snapshot, "snapshot");
        if (snapshot.schemaVersion() != SUPPORTED_SCHEMA || snapshot.proposalsIncluded()
                || snapshot.meeting() == null || snapshot.meeting().id() == null
                || snapshot.meeting().status() == null || snapshot.summary() == null
                || snapshot.transcript() == null
                || !COMPLETENESS.contains(snapshot.completeness())
                || snapshot.sourceFingerprint() == null
                || !DIGEST.matcher(snapshot.sourceFingerprint()).matches()
                || !AVAILABILITY.contains(snapshot.summary().availability())
                || !AVAILABILITY.contains(snapshot.transcript().availability())
                || (snapshot.summary().id() == null)
                       != "NOT_AVAILABLE".equals(snapshot.summary().availability())
                || (snapshot.transcript().id() == null)
                       != "NOT_AVAILABLE".equals(snapshot.transcript().availability())) {
            throw new IllegalArgumentException("Invalid or unsupported Minutes snapshot");
        }
        for (var decision : snapshot.confirmedDecisions()) {
            if (!"CONFIRMED".equals(decision.status())) {
                throw new IllegalArgumentException("Unconfirmed Decision in official Minutes");
            }
        }
        for (var action : snapshot.officialActionItems()) {
            if (!OFFICIAL_ACTION_STATUSES.contains(action.status())
                    || (!"MANUAL".equals(action.sourceType())
                        && action.confirmedByUserId() == null)) {
                throw new IllegalArgumentException("Unconfirmed Action Item in official Minutes");
            }
        }
    }

    private static void section(StringBuilder out, String title) {
        out.append("\n## ").append(title).append("\n\n");
    }

    private static void field(StringBuilder out, String label, Object value) {
        out.append("- **").append(label).append(":** ");
        if (value == null || value instanceof String s && s.isBlank()) {
            out.append("Chưa có dữ liệu");
        } else {
            out.append(SafeMarkdownText.inline(value.toString()));
        }
        out.append('\n');
    }

    private static void warningList(StringBuilder out, List<String> warnings, String label) {
        for (String warning : warnings) field(out, label, warning);
    }

    private static String instant(OffsetDateTime value) {
        return value == null ? null : value.toInstant().toString();
    }

}
