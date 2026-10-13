package com.sme.meetingassistant.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.common.ApiErrorCode;
import com.sme.meetingassistant.api.common.ApiMeta;
import com.sme.meetingassistant.api.common.ApiResponse;
import com.sme.meetingassistant.api.common.ApiResponseFactory;
import com.sme.meetingassistant.api.observability.RequestIdContext;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.Map;
import java.util.UUID;
import org.hamcrest.Matchers;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.RequestPostProcessor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.ModelAttribute;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.ErrorResponseException;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

@ActiveProfiles("test")
@SpringBootTest
@AutoConfigureMockMvc
@Import({ CommonApiContractTests.ContractController.class, PostgresTestConfiguration.class })
class CommonApiContractTests {

 private static final String TRUSTED_REMOTE_ADDRESS = "127.0.0.1";
 private static final String REQUEST_ID = "11111111-1111-4111-8111-111111111111";

 @Autowired
 private MockMvc mockMvc;

 @Autowired
 private ObjectMapper objectMapper;

 @Autowired
 private ApiResponseFactory responseFactory;

 @Test
 void responseSerializationKeepsNullableDataAndOmitsNonValidationErrors() throws Exception {
  ApiMeta meta = new ApiMeta(REQUEST_ID, OffsetDateTime.parse("2026-01-02T12:34:56+02:00"));
  ApiResponse<String> response = new ApiResponse<>(true, ApiErrorCode.SUCCESS.name(), "Accepted", null, meta, null);

  JsonNode json = this.objectMapper.readTree(this.objectMapper.writeValueAsString(response));

  assertThat(json.path("success").asBoolean()).isTrue();
  assertThat(json.path("code").asText()).isEqualTo("SUCCESS");
  assertThat(json.path("data").isNull()).isTrue();
  assertThat(json.has("errors")).isFalse();
  assertThat(json.path("meta").path("requestId").asText()).isEqualTo(REQUEST_ID);
  assertThat(OffsetDateTime.parse(json.path("meta").path("timestamp").asText()).getOffset())
    .isEqualTo(ZoneOffset.UTC);
  assertThat(json.path("meta").path("timestamp").asText()).isEqualTo("2026-01-02T10:34:56Z");
 }

 @Test
 void successUsesTheCanonicalRequestIdInTheHeaderAndMetadata() throws Exception {
  MvcResult result = this.mockMvc.perform(get("/api/v1/contract/success")
      .header(RequestIdContext.HEADER_NAME, REQUEST_ID)
      .with(remoteAddress(TRUSTED_REMOTE_ADDRESS)))
    .andExpect(status().isOk())
    .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON))
    .andExpect(header().string(RequestIdContext.HEADER_NAME, REQUEST_ID))
    .andReturn();

  JsonNode json = this.objectMapper.readTree(result.getResponse().getContentAsString());
  assertThat(json.path("success").asBoolean()).isTrue();
  assertThat(json.path("code").asText()).isEqualTo("SUCCESS");
  assertThat(json.path("data").path("value").asText()).isEqualTo("ok");
  assertThat(json.path("meta").path("requestId").asText()).isEqualTo(REQUEST_ID);
  assertThat(json.has("errors")).isFalse();
 }

 @Test
 void malformedJsonUsesAStableSafeBadRequestEnvelope() throws Exception {
  MvcResult result = this.mockMvc.perform(post("/api/v1/contract/body")
      .contentType(MediaType.APPLICATION_JSON)
      .content("{"))
    .andExpect(status().isBadRequest())
    .andReturn();

  assertError(result, HttpStatus.BAD_REQUEST, ApiErrorCode.MALFORMED_REQUEST, "Request body is malformed or unreadable.");
  assertThat(result.getResponse().getContentAsString())
    .doesNotContain("JsonParseException", "at [Source", "java.");
 }

 @Test
 void semanticBodyValidationReturnsDeterministicallySortedFieldErrors() throws Exception {
  MvcResult result = this.mockMvc.perform(post("/api/v1/contract/body")
      .contentType(MediaType.APPLICATION_JSON)
      .content("{}"))
    .andExpect(status().isUnprocessableEntity())
    .andReturn();

  JsonNode json = assertError(result, HttpStatus.UNPROCESSABLE_ENTITY, ApiErrorCode.VALIDATION_FAILED,
    "Request validation failed.");
  JsonNode errors = json.path("errors");
  assertThat(errors).hasSize(2);
  assertThat(errors.get(0).path("field").asText()).isEqualTo("name");
  assertThat(errors.get(0).path("code").asText()).isEqualTo("NOT_BLANK");
  assertThat(errors.get(0).path("message").asText()).isEqualTo("must not be blank");
  assertThat(errors.get(1).path("field").asText()).isEqualTo("title");
  assertThat(errors.get(1).path("code").asText()).isEqualTo("NOT_BLANK");
  assertThat(errors.get(1).path("message").asText()).isEqualTo("must not be blank");
 }

 @Test
  void methodParameterValidationUsesTheSameStructuredEnvelope() throws Exception {
   MvcResult result = this.mockMvc.perform(get("/api/v1/contract/parameter").param("query", ""))
     .andExpect(status().isUnprocessableEntity())
     .andReturn();

  JsonNode json = assertError(result, HttpStatus.UNPROCESSABLE_ENTITY, ApiErrorCode.VALIDATION_FAILED,
    "Request validation failed.");
   assertThat(json.path("errors").toString()).contains("query", "NOT_BLANK");
  }

  @Test
  void returnValueValidationFailureIsAnInternalErrorNotClientValidation() throws Exception {
   MvcResult result = this.mockMvc.perform(get("/api/v1/contract/invalid-return"))
     .andExpect(status().isInternalServerError())
     .andReturn();

   assertError(result, HttpStatus.INTERNAL_SERVER_ERROR, ApiErrorCode.INTERNAL_ERROR,
     "An unexpected error occurred.");
   assertThat(result.getResponse().getContentAsString()).doesNotContain("NotNull", "invalid return value");
  }

 @Test
  void modelAttributeBindingValidationUsesTheSameStructuredEnvelope() throws Exception {
   MvcResult result = this.mockMvc.perform(get("/api/v1/contract/binding").param("name", ""))
     .andExpect(status().isUnprocessableEntity())
     .andReturn();

  JsonNode json = assertError(result, HttpStatus.UNPROCESSABLE_ENTITY, ApiErrorCode.VALIDATION_FAILED,
    "Request validation failed.");
   assertThat(json.path("errors").toString()).contains("name", "NOT_BLANK");
  }

  @Test
  void authenticationAndAuthorizationStatusesUseStableCodesAndPreserveHeaders() throws Exception {
   MvcResult unauthorized = this.mockMvc.perform(get("/api/v1/contract/unauthorized")).andReturn();
   assertError(unauthorized, HttpStatus.UNAUTHORIZED, ApiErrorCode.AUTH_REQUIRED, "Authentication is required.");
   assertThat(unauthorized.getResponse().getHeader(HttpHeaders.WWW_AUTHENTICATE))
     .isEqualTo("Bearer realm=\"api\"");

   MvcResult forbidden = this.mockMvc.perform(get("/api/v1/contract/forbidden")).andReturn();
   assertError(forbidden, HttpStatus.FORBIDDEN, ApiErrorCode.AUTHZ_FORBIDDEN,
     "Access to this resource is forbidden.");
 }

 @Test
 void genuinelyUnsupportedMethodUsesSpringDispatchAndPreservesAllowHeader() throws Exception {
  MvcResult result = this.mockMvc.perform(post("/api/v1/contract/method-only")
      .header(RequestIdContext.HEADER_NAME, REQUEST_ID)
      .with(remoteAddress(TRUSTED_REMOTE_ADDRESS)))
    .andExpect(status().isMethodNotAllowed())
    .andExpect(header().string(HttpHeaders.ALLOW, Matchers.containsString("GET")))
    .andReturn();

  assertError(result, HttpStatus.METHOD_NOT_ALLOWED, ApiErrorCode.METHOD_NOT_ALLOWED,
    "The HTTP method is not supported for this resource.");
 }

 @Test
 void rateLimitStatusUsesAStableCodeAndPreservesRetryAfterHeader() throws Exception {
  MvcResult result = this.mockMvc.perform(get("/api/v1/contract/rate-limit")).andReturn();

  assertError(result, HttpStatus.TOO_MANY_REQUESTS, ApiErrorCode.RATE_LIMIT_EXCEEDED, "Too many requests.");
  assertThat(result.getResponse().getHeader(HttpHeaders.RETRY_AFTER)).isEqualTo("60");
 }

 @Test
 void malformedTransportParametersUseSafeBadRequestClassification() throws Exception {
  MvcResult invalidInteger = this.mockMvc.perform(get("/api/v1/contract/integer").param("value", "not-an-integer"))
    .andReturn();
  assertError(invalidInteger, HttpStatus.BAD_REQUEST, ApiErrorCode.MALFORMED_REQUEST,
    "Request body is malformed or unreadable.");

  MvcResult missingParameter = this.mockMvc.perform(get("/api/v1/contract/required")).andReturn();
  assertError(missingParameter, HttpStatus.BAD_REQUEST, ApiErrorCode.MALFORMED_REQUEST,
    "Request body is malformed or unreadable.");

  MvcResult invalidUuid = this.mockMvc.perform(get("/api/v1/contract/uuid/not-a-uuid")).andReturn();
  assertError(invalidUuid, HttpStatus.BAD_REQUEST, ApiErrorCode.MALFORMED_REQUEST,
    "Request body is malformed or unreadable.");

  assertThat(invalidInteger.getResponse().getContentAsString())
    .doesNotContain("NumberFormatException", "MethodArgumentTypeMismatchException", "java.lang");
  assertThat(missingParameter.getResponse().getContentAsString())
    .doesNotContain("MissingServletRequestParameterException", "java.lang");
  assertThat(invalidUuid.getResponse().getContentAsString())
    .doesNotContain("UUID", "MethodArgumentTypeMismatchException", "java.lang");
 }

 @Test
  void frameworkStatusesArePreservedWithStableSafeCodes() throws Exception {
   assertError(this.mockMvc.perform(get("/api/v1/contract/not-found")).andReturn(), HttpStatus.NOT_FOUND,
     ApiErrorCode.NOT_FOUND, "The requested resource was not found.");
  assertError(this.mockMvc.perform(get("/api/v1/contract/conflict")).andReturn(), HttpStatus.CONFLICT,
    ApiErrorCode.CONFLICT, "The request conflicts with the current state.");
  assertError(this.mockMvc.perform(get("/api/v1/contract/precondition")).andReturn(),
    HttpStatus.PRECONDITION_FAILED, ApiErrorCode.PRECONDITION_FAILED, "The request precondition failed.");
   assertError(this.mockMvc.perform(post("/api/v1/contract/media")
       .contentType(MediaType.TEXT_PLAIN)
       .content("not-json")).andReturn(), HttpStatus.UNSUPPORTED_MEDIA_TYPE,
     ApiErrorCode.UNSUPPORTED_MEDIA_TYPE, "The request media type is not supported.");

   MvcResult unsupportedMediaType = this.mockMvc.perform(post("/api/v1/contract/media")
       .contentType(MediaType.TEXT_PLAIN)
       .content("not-json")).andReturn();
   assertThat(unsupportedMediaType.getResponse().getHeader(HttpHeaders.ACCEPT))
     .contains(MediaType.APPLICATION_JSON_VALUE);
 }

 @Test
 void additionalStandardStatusesUseStableTransportCodes() throws Exception {
  assertError(this.mockMvc.perform(get("/api/v1/contract/not-acceptable")
      .accept(MediaType.TEXT_PLAIN)).andReturn(), HttpStatus.NOT_ACCEPTABLE,
    ApiErrorCode.NOT_ACCEPTABLE, "The requested response representation is not available.");
  assertError(this.mockMvc.perform(get("/api/v1/contract/payload-too-large")).andReturn(),
    HttpStatus.PAYLOAD_TOO_LARGE, ApiErrorCode.PAYLOAD_TOO_LARGE,
    "The request payload exceeds the permitted limit.");
  assertError(this.mockMvc.perform(get("/api/v1/contract/bad-gateway")).andReturn(), HttpStatus.BAD_GATEWAY,
    ApiErrorCode.INTERNAL_BAD_GATEWAY, "An upstream service returned an invalid response.");
  assertError(this.mockMvc.perform(get("/api/v1/contract/service-unavailable")).andReturn(),
    HttpStatus.SERVICE_UNAVAILABLE, ApiErrorCode.INTERNAL_SERVICE_UNAVAILABLE,
    "The service is temporarily unavailable.");
  assertError(this.mockMvc.perform(get("/api/v1/contract/gateway-timeout")).andReturn(),
    HttpStatus.GATEWAY_TIMEOUT, ApiErrorCode.INTERNAL_GATEWAY_TIMEOUT,
    "An upstream service timed out.");
 }

 @Test
 void unrecognizedFrameworkStatusesRemainClassifiedByHttpFamily() throws Exception {
  assertError(this.mockMvc.perform(get("/api/v1/contract/unrecognized-client-error")).andReturn(),
    HttpStatus.I_AM_A_TEAPOT, ApiErrorCode.CLIENT_ERROR, "The request could not be processed.");

  MvcResult unrecognizedServerError = this.mockMvc.perform(get("/api/v1/contract/unrecognized-server-error"))
    .andReturn();
  assertError(unrecognizedServerError, HttpStatusCode.valueOf(599), ApiErrorCode.INTERNAL_ERROR,
    "An unexpected error occurred.");
 }

 @Test
 void unexpectedFailuresHaveAStatusPreservingSafeEnvelopeAndCorrelation() throws Exception {
  MvcResult result = this.mockMvc.perform(get("/api/v1/contract/unexpected")
      .header(RequestIdContext.HEADER_NAME, REQUEST_ID)
      .with(remoteAddress(TRUSTED_REMOTE_ADDRESS)))
    .andExpect(status().isInternalServerError())
    .andExpect(header().string(RequestIdContext.HEADER_NAME, REQUEST_ID))
    .andReturn();

  JsonNode json = assertError(result, HttpStatus.INTERNAL_SERVER_ERROR, ApiErrorCode.INTERNAL_ERROR,
    "An unexpected error occurred.");
  assertThat(json.path("meta").path("requestId").asText()).isEqualTo(REQUEST_ID);
  assertThat(result.getResponse().getContentAsString())
    .doesNotContain("SQL password", "IllegalStateException", "secret-value");
 }

  private JsonNode assertError(MvcResult result, HttpStatusCode status, ApiErrorCode code, String message)
    throws Exception {
  assertThat(result.getResponse().getStatus()).isEqualTo(status.value());
  JsonNode json = this.objectMapper.readTree(result.getResponse().getContentAsString());
  assertThat(json.path("success").asBoolean()).isFalse();
  assertThat(json.path("code").asText()).isEqualTo(code.name());
  assertThat(json.path("message").asText()).isEqualTo(message);
  assertThat(json.path("data").isNull()).isTrue();
  assertThat(json.path("meta").path("requestId").asText())
    .isEqualTo(result.getResponse().getHeader(RequestIdContext.HEADER_NAME));
  return json;
 }

 private static RequestPostProcessor remoteAddress(String remoteAddress) {
  return request -> {
   request.setRemoteAddr(remoteAddress);
   return request;
  };
 }

 @RestController
 @RequestMapping("/api/v1/contract")
  static class ContractController {

  private final ApiResponseFactory responseFactory;

  ContractController(ApiResponseFactory responseFactory) {
   this.responseFactory = responseFactory;
  }

  @GetMapping("/success")
  ApiResponse<Map<String, String>> success() {
   return this.responseFactory.success("Request completed successfully.", Map.of("value", "ok"));
  }

  @PostMapping("/body")
  ApiResponse<String> body(@Valid @RequestBody BodyRequest request) {
   return this.responseFactory.success("Accepted", request.title());
  }

  @GetMapping("/parameter")
  ApiResponse<String> parameter(@RequestParam(defaultValue = "") @NotBlank String query) {
   return this.responseFactory.success("Accepted", query);
  }

   @GetMapping("/binding")
   ApiResponse<String> binding(@Valid @ModelAttribute BindingRequest request) {
    return this.responseFactory.success("Accepted", request.getName());
   }

   @GetMapping("/invalid-return")
   @NotNull
   String invalidReturn() {
    return null;
   }

   @GetMapping("/unauthorized")
   ApiResponse<String> unauthorized() {
    ErrorResponseException exception = new ErrorResponseException(HttpStatus.UNAUTHORIZED);
    exception.setDetail("sensitive auth detail");
    exception.getHeaders().set(HttpHeaders.WWW_AUTHENTICATE, "Bearer realm=\"api\"");
    throw exception;
   }

   @GetMapping("/forbidden")
   ApiResponse<String> forbidden() {
    throw new ResponseStatusException(HttpStatus.FORBIDDEN, "sensitive authorization detail");
   }

   @GetMapping("/method-only")
   ApiResponse<String> methodOnly() {
    return this.responseFactory.success("Accepted", "get");
   }

   @GetMapping("/rate-limit")
   ApiResponse<String> rateLimit() {
    ErrorResponseException exception = new ErrorResponseException(HttpStatus.TOO_MANY_REQUESTS);
    exception.setDetail("sensitive rate-limit detail");
    exception.getHeaders().set(HttpHeaders.RETRY_AFTER, "60");
    throw exception;
   }

   @GetMapping("/integer")
   ApiResponse<String> integer(@RequestParam int value) {
    return this.responseFactory.success("Accepted", Integer.toString(value));
   }

   @GetMapping("/required")
   ApiResponse<String> required(@RequestParam String value) {
    return this.responseFactory.success("Accepted", value);
   }

   @GetMapping("/uuid/{id}")
   ApiResponse<String> uuid(@PathVariable UUID id) {
    return this.responseFactory.success("Accepted", id.toString());
   }

  @GetMapping("/not-found")
  ApiResponse<String> notFound() {
   throw new ResponseStatusException(HttpStatus.NOT_FOUND, "sensitive not-found detail");
  }

  @GetMapping("/conflict")
  ApiResponse<String> conflict() {
   throw new ResponseStatusException(HttpStatus.CONFLICT, "sensitive conflict detail");
  }

  @GetMapping("/precondition")
  ApiResponse<String> precondition() {
   throw new ResponseStatusException(HttpStatus.PRECONDITION_FAILED, "sensitive precondition detail");
  }

   @PostMapping(value = "/media", consumes = MediaType.APPLICATION_JSON_VALUE)
   ApiResponse<String> media(@RequestBody Map<String, Object> request) {
    return this.responseFactory.success("Accepted", request.toString());
   }

   @GetMapping(value = "/not-acceptable", produces = MediaType.APPLICATION_JSON_VALUE)
   ApiResponse<String> notAcceptable() {
    return this.responseFactory.success("Accepted", "json");
   }

   @GetMapping("/payload-too-large")
   ApiResponse<String> payloadTooLarge() {
    throw new ResponseStatusException(HttpStatus.PAYLOAD_TOO_LARGE, "sensitive payload detail");
   }

   @GetMapping("/bad-gateway")
   ApiResponse<String> badGateway() {
    throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, "sensitive upstream detail");
   }

   @GetMapping("/service-unavailable")
   ApiResponse<String> serviceUnavailable() {
    throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "sensitive availability detail");
   }

   @GetMapping("/gateway-timeout")
   ApiResponse<String> gatewayTimeout() {
    throw new ResponseStatusException(HttpStatus.GATEWAY_TIMEOUT, "sensitive timeout detail");
   }

   @GetMapping("/unrecognized-client-error")
   ApiResponse<String> unrecognizedClientError() {
    throw new ResponseStatusException(HttpStatus.I_AM_A_TEAPOT, "sensitive client detail");
   }

   @GetMapping("/unrecognized-server-error")
   ApiResponse<String> unrecognizedServerError() {
    throw new ResponseStatusException(HttpStatusCode.valueOf(599), "sensitive server detail");
   }

  @GetMapping("/unexpected")
  ApiResponse<String> unexpected() {
   throw new IllegalStateException("SQL password=secret-value");
  }

 }

 record BodyRequest(@NotBlank String title, @NotBlank String name) {
 }

 static class BindingRequest {

  @NotBlank
  private String name;

  public String getName() {
   return this.name;
  }

  public void setName(String name) {
   this.name = name;
  }

 }

}
