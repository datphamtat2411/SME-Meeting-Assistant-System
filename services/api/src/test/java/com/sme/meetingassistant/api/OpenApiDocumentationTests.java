package com.sme.meetingassistant.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.common.ApiResponse;
import com.sme.meetingassistant.api.common.ApiResponseFactory;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

@ActiveProfiles("test")
@SpringBootTest
@AutoConfigureMockMvc
@Import({ OpenApiDocumentationTests.DocumentationController.class, PostgresTestConfiguration.class })
class OpenApiDocumentationTests {

 @Autowired
 private MockMvc mockMvc;

 @Autowired
 private ObjectMapper objectMapper;

 @Test
 void generatedDocumentationContainsStableMetadataFilteredPathsAndResponseSchemas() throws Exception {
  String body = this.mockMvc.perform(get("/v3/api-docs"))
    .andExpect(status().isOk())
    .andReturn()
    .getResponse()
    .getContentAsString();

  JsonNode document = this.objectMapper.readTree(body);
  assertThat(document.path("info").path("title").asText()).isEqualTo("SME Meeting Assistant API");
  assertThat(document.path("info").path("version").asText()).isEqualTo("1.0.0");
  assertThat(document.path("paths").has("/api/v1/documented")).isTrue();
  assertThat(document.path("paths").has("/outside")).isFalse();
  assertThat(document.path("paths").has("/v3/api-docs")).isFalse();
  assertThat(hasEnvelopeSchema(document.path("components").path("schemas"))).isTrue();
 }

 @Test
 void integratedPublicContractDocumentsDurableAdmissionAndObservation() throws Exception {
  String body = this.mockMvc.perform(get("/v3/api-docs"))
    .andExpect(status().isOk()).andReturn().getResponse().getContentAsString();
  JsonNode paths = this.objectMapper.readTree(body).path("paths");
  String assistant = "/api/v1/assistant/conversations";
  assertResponse(paths, assistant, "post", "201");
  assertResponse(paths, assistant + "/{conversationId}/messages", "post", "200");
  assertResponse(paths, assistant + "/{conversationId}/messages", "post", "202");
  assertResponse(paths, assistant + "/{conversationId}/turns/{turnId}/recover", "post", "202");
  assertHeader(paths, assistant + "/{conversationId}/messages", "post", "Idempotency-Key", true);
  assertHeader(paths, assistant + "/{conversationId}/turns", "get", "Idempotency-Key", true);
  assertThat(paths.path(assistant + "/{conversationId}/turns/{turnId}").has("get")).isTrue();
  assertThat(paths.path(assistant + "/{conversationId}/messages/{messageId}/evidence").has("get")).isTrue();
  assertThat(paths.path("/api/v1/action-items/management-targets").has("get")).isTrue();
  assertThat(paths.path("/api/v1/action-items/assignee-candidates").has("get")).isTrue();
  assertResponse(paths, "/api/v1/action-items", "post", "201");
  assertResponse(paths, "/api/v1/meetings/{meetingId}/media/uploads", "post", "201");
  assertResponse(paths, "/api/v1/meetings/{meetingId}/processing-jobs", "post", "202");
  assertResponse(paths, "/api/v1/processing-jobs/{jobId}/retry", "post", "202");
  assertResponse(paths, "/api/v1/processing-jobs/{jobId}/meeting-intelligence/admit", "post", "202");
  assertHeader(paths, "/api/v1/processing-jobs/{jobId}/retry", "post", "Idempotency-Key", true);
  assertHeader(paths, "/api/v1/action-items/{actionItemId}", "patch", "If-Match", true);
  assertHeader(paths, "/api/v1/meetings/{meetingId}/transcript/segments/{segmentId}", "patch", "If-Match", true);
 }

 private static void assertResponse(JsonNode paths, String path, String method, String code) {
  assertThat(paths.path(path).path(method).path("responses").has(code))
    .as("%s %s documents HTTP %s", method, path, code).isTrue();
 }

 private static void assertHeader(JsonNode paths, String path, String method, String name, boolean required) {
  boolean found = false;
  for (JsonNode parameter : paths.path(path).path(method).path("parameters")) {
   if (name.equalsIgnoreCase(parameter.path("name").asText())
     && "header".equals(parameter.path("in").asText())) {
    assertThat(parameter.path("required").asBoolean()).isEqualTo(required);
    found = true;
   }
  }
  assertThat(found).as("%s %s documents %s", method, path, name).isTrue();
 }

 private static boolean hasEnvelopeSchema(JsonNode schemas) {
  for (var schema : schemas.properties()) {
   JsonNode properties = schema.getValue().path("properties");
   if (properties.has("success") && properties.has("code") && properties.has("message")
     && properties.has("data") && properties.has("meta")) {
    return true;
   }
  }
  return false;
 }

 @org.springframework.web.bind.annotation.RestController
 static class DocumentationController {

  private final ApiResponseFactory responseFactory;

  DocumentationController(ApiResponseFactory responseFactory) {
   this.responseFactory = responseFactory;
  }

  @org.springframework.web.bind.annotation.GetMapping("/api/v1/documented")
  ApiResponse<String> documented() {
   return this.responseFactory.success("Documented", "ok");
  }

  @org.springframework.web.bind.annotation.GetMapping("/outside")
  ApiResponse<String> outside() {
   return this.responseFactory.success("Outside", "not documented");
  }

 }

}
