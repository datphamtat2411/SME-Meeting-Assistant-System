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
import org.springframework.test.web.servlet.MockMvc;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

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
