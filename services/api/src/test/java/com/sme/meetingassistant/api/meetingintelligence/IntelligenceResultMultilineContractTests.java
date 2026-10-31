package com.sme.meetingassistant.api.meetingintelligence;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.sme.meetingassistant.api.meetingintelligence.service.IntelligenceResultPayload;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

/** Direct v1 parser/schema agreement fixtures, without a new schema engine. */
class IntelligenceResultMultilineContractTests {
    private final ObjectMapper json=new ObjectMapper();
    private static final UUID JOB=UUID.randomUUID();
    private static final UUID STAGE=UUID.randomUUID();
    private static final UUID TRANSCRIPT=UUID.randomUUID();
    private static final UUID SOURCE=UUID.randomUUID();
    private static final UUID EVIDENCE=UUID.randomUUID();

    private byte[] envelope(String type,String content) {
        Map<String,Object> result="SUMMARY".equals(type)
            ? Map.of("content",content,"warnings",List.of())
            : Map.of("candidates",List.of(Map.of(
                "candidateKey","proposed-1","content",content,
                "uncertainty","MATERIAL","evidenceSegmentIds",List.of(EVIDENCE.toString()))),
                "warnings",List.of());
        return json.writeValueAsBytes(Map.of(
            "schemaVersion","1.0","resultType",type,
            "processingJobId",JOB.toString(),"stageRunId",STAGE.toString(),
            "source",Map.of("transcriptId",TRANSCRIPT.toString(),
                "contentRevision",3,"inputSnapshotId",SOURCE.toString(),
                "sha256","a".repeat(64)),
            "producer",Map.of("model","vi-summarizer","promptVersion","v1"),
            "result",result));
    }

    private String readContent(String type,String text) {
        var parsed=IntelligenceResultPayload.parse(envelope(type,text),json);
        return "SUMMARY".equals(type)?parsed.summary():parsed.candidates().getFirst().content();
    }

    @SuppressWarnings("unchecked")
    private Map<String,Object> contract() throws Exception {
        // Maven runs from services/api; load the exact file delivered to AI team.
        return json.readValue(Files.readAllBytes(Path.of(
            "docs/contracts/meeting-intelligence-result-v1.schema.json")),Map.class);
    }

    @SuppressWarnings("unchecked")
    private String schemaPattern(String section,String field) throws Exception {
        Map<String,Object> defs=(Map<String,Object>)contract().get("$defs");
        Map<String,Object> sectionDef=(Map<String,Object>)defs.get(section);
        Map<String,Object> properties=(Map<String,Object>)sectionDef.get("properties");
        return (String)((Map<String,Object>)properties.get(field)).get("pattern");
    }

    @Test
    void vietnameseParagraphsPreserveUnicodeAndTabsWhileNormalizingOnlyCrLf() {
        String original="Kết luận phiên họp:\r\n\t• Thống nhất ngân sách.\r\n"
            +"• Giao nhóm nghiên cứu trước thứ Sáu.\nTóm tắt: Hòa bình.";
        String expected=original.replace("\r\n","\n");
        for(String type:List.of("SUMMARY","DECISION_EXTRACTION")) {
            assertThat(readContent(type,original)).isEqualTo(expected)
                .contains("\n\t• Thống nhất").contains("Hòa bình.");
        }
        assertThat(readContent("SUMMARY","Ý kiến đầu tiên\nÝ kiến thứ hai"))
            .isEqualTo("Ý kiến đầu tiên\nÝ kiến thứ hai");
    }

    @Test
    void contentSchemaAndParserAgreeOnAllowedAndRejectedControls() throws Exception {
        String patternSummary=schemaPattern("summaryResult","content");
        String patternDecision=schemaPattern("decisionCandidate","content");
        assertThat(patternSummary).isEqualTo(patternDecision);
        Pattern p=Pattern.compile(patternSummary);
        List<String> valid=List.of("Nội dung tiếng Việt","Mục 1\nMục 2",
            "A\r\nB","Cột\tGiá trị","A\r\n\tB","🌿 Tương lai — nghiên cứu",
            "Á".repeat(5_000));
        for(String text:valid) {
            assertThat(p.matcher(text).find()).as("schema valid").isTrue();
            assertThat(readContent("SUMMARY",text)).isEqualTo(text.replace("\r\n","\n"));
            assertThat(readContent("DECISION_EXTRACTION",text))
                .isEqualTo(text.replace("\r\n","\n"));
        }
        List<String> invalid=List.of("","   ","\n\t","\r","A\rB","A\r",
            "A\u0000B","A\u0008B","A\u000BB","A\u000CB",
            "A\u001BB","A\u007FB","A\u0085B");
        for(String text:invalid) {
            assertThat(p.matcher(text).find()).as("schema rejects unsafe content").isFalse();
            assertThatThrownBy(()->readContent("SUMMARY",text))
                .isInstanceOf(IllegalArgumentException.class);
            assertThatThrownBy(()->readContent("DECISION_EXTRACTION",text))
                .isInstanceOf(IllegalArgumentException.class);
        }
    }

    @Test
    void originalLengthLimitCannotBeBypassedByCrLfCollapsing() throws Exception {
        assertThat(readContent("SUMMARY","á".repeat(20_000))).hasSize(20_000);
        assertThat(readContent("DECISION_EXTRACTION","á".repeat(5_000)))
            .hasSize(5_000);
        for(String type:List.of("SUMMARY","DECISION_EXTRACTION")) {
            int max="SUMMARY".equals(type)?20_000:5_000;
            assertThatThrownBy(()->readContent(type,"á".repeat(max+1)))
                .isInstanceOf(IllegalArgumentException.class);
            assertThatThrownBy(()->readContent(type,"á".repeat(max-1)+"\r\n"))
                .isInstanceOf(IllegalArgumentException.class);
        }
        // JSON Schema counts Unicode scalar characters, not Java UTF-16 units.
        assertThat(readContent("DECISION_EXTRACTION","😀".repeat(5_000)))
            .isEqualTo("😀".repeat(5_000));
    }

    @Test
    void producerMetadataRemainsSingleLineAndSchemaMatches() throws Exception {
        Pattern metadata=Pattern.compile(schemaPattern("producer","model"));
        assertThat(metadata.matcher("valid-vi-model")).find();
        for(String text:List.of(""," ","m\nx","m\r\nx","m\tx","x\u0000y",
                "x\u001By","x\u007Fy","x\u0085y")){
            assertThat(metadata.matcher(text).find()).isFalse();
            Map<String,Object> root=json.readValue(envelope("SUMMARY","Nội dung"),Map.class);
            @SuppressWarnings("unchecked")
            Map<String,Object> producer=(Map<String,Object>)root.get("producer");
            producer.put("model",text);
            assertThatThrownBy(()->IntelligenceResultPayload.parse(
                json.writeValueAsBytes(root),json))
                .isInstanceOf(IllegalArgumentException.class);
        }
        assertThat(schemaPattern("producer","promptVersion"))
            .isEqualTo(schemaPattern("producer","model"));
        assertThat(schemaPattern("producer","provider"))
            .isEqualTo(schemaPattern("producer","model"));
    }

    @Test
    void strictV1ResultShapeAndWarningEnumsStillRejectUnexpectedFields() {
        Map<String,Object> root=json.readValue(envelope("SUMMARY","Nội dung"),Map.class);
        root.put("actorId",UUID.randomUUID().toString());
        assertThatThrownBy(()->IntelligenceResultPayload.parse(
            json.writeValueAsBytes(root),json)).isInstanceOf(IllegalArgumentException.class);
        root.remove("actorId");
        root.put("schemaVersion","2.0");
        assertThatThrownBy(()->IntelligenceResultPayload.parse(
            json.writeValueAsBytes(root),json)).isInstanceOf(IllegalArgumentException.class);
        root.put("schemaVersion","1.0");
        @SuppressWarnings("unchecked")
        Map<String,Object> result=(Map<String,Object>)root.get("result");
        result.put("warnings",List.of("UNAPPROVED_WARNING"));
        assertThatThrownBy(()->IntelligenceResultPayload.parse(
            json.writeValueAsBytes(root),json)).isInstanceOf(IllegalArgumentException.class);
    }
}
