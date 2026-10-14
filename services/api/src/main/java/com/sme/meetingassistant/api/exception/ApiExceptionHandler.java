package com.sme.meetingassistant.api.exception;

import com.sme.meetingassistant.api.common.ApiErrorCode;
import com.sme.meetingassistant.api.common.ApiFieldError;
import com.sme.meetingassistant.api.common.ApiResponse;
import com.sme.meetingassistant.api.common.ApiResponseFactory;
import jakarta.validation.ConstraintViolation;
import jakarta.validation.ConstraintViolationException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import org.springframework.context.MessageSourceResolvable;
import org.springframework.core.MethodParameter;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.validation.BindException;
import org.springframework.validation.Errors;
import org.springframework.validation.FieldError;
import org.springframework.validation.ObjectError;
import org.springframework.validation.method.ParameterErrors;
import org.springframework.validation.method.ParameterValidationResult;
import org.springframework.web.ErrorResponse;
import org.springframework.web.bind.MissingPathVariableException;
import org.springframework.web.bind.ServletRequestBindingException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.method.annotation.HandlerMethodValidationException;

@RestControllerAdvice
public class ApiExceptionHandler {

	private static final String MALFORMED_MESSAGE = "Request body is malformed or unreadable.";
	private static final String CLIENT_ERROR_MESSAGE = "The request could not be processed.";
	private static final String AUTH_REQUIRED_MESSAGE = "Authentication is required.";
	private static final String FORBIDDEN_MESSAGE = "Access to this resource is forbidden.";
	private static final String VALIDATION_MESSAGE = "Request validation failed.";
	private static final String NOT_FOUND_MESSAGE = "The requested resource was not found.";
	private static final String METHOD_NOT_ALLOWED_MESSAGE = "The HTTP method is not supported for this resource.";
	private static final String NOT_ACCEPTABLE_MESSAGE = "The requested response representation is not available.";
	private static final String CONFLICT_MESSAGE = "The request conflicts with the current state.";
	private static final String PRECONDITION_MESSAGE = "The request precondition failed.";
	private static final String PAYLOAD_TOO_LARGE_MESSAGE = "The request payload exceeds the permitted limit.";
	private static final String MEDIA_TYPE_MESSAGE = "The request media type is not supported.";
	private static final String RATE_LIMIT_MESSAGE = "Too many requests.";
	private static final String BAD_GATEWAY_MESSAGE = "An upstream service returned an invalid response.";
	private static final String SERVICE_UNAVAILABLE_MESSAGE = "The service is temporarily unavailable.";
	private static final String GATEWAY_TIMEOUT_MESSAGE = "An upstream service timed out.";
	private static final String INTERNAL_MESSAGE = "An unexpected error occurred.";

	private final ApiResponseFactory responseFactory;
	private final Http500DiagnosticLogger diagnosticLogger;

	public ApiExceptionHandler(ApiResponseFactory responseFactory, Http500DiagnosticLogger diagnosticLogger) {
		this.responseFactory = responseFactory;
		this.diagnosticLogger = diagnosticLogger;
	}

	@ExceptionHandler(Exception.class)
	public ResponseEntity<ApiResponse<Void>> handle(Exception exception) {
		ResponseEntity<ApiResponse<Void>> response;
		if (isReturnValueValidationFailure(exception)) {
			response = response(HttpStatus.INTERNAL_SERVER_ERROR, ApiErrorCode.INTERNAL_ERROR, INTERNAL_MESSAGE, null);
		}
		else if (isMalformedRequest(exception)) {
			response = response(HttpStatus.BAD_REQUEST, ApiErrorCode.MALFORMED_REQUEST, MALFORMED_MESSAGE, null);
		}
		else {
			List<ApiFieldError> validationErrors = validationErrors(exception);
			if (validationErrors != null) {
				response = response(HttpStatus.UNPROCESSABLE_ENTITY, ApiErrorCode.VALIDATION_FAILED, VALIDATION_MESSAGE,
					validationErrors);
			}
			else if (exception instanceof ErrorResponse errorResponse) {
				HttpStatusCode status = errorResponse.getStatusCode();
				ErrorDescriptor descriptor = errorDescriptor(status);
				response = response(errorStatus(status), descriptor, errorResponse.getHeaders());
			}
			else {
				response = response(HttpStatus.INTERNAL_SERVER_ERROR, ApiErrorCode.INTERNAL_ERROR, INTERNAL_MESSAGE, null);
			}
		}

		if (response.getStatusCode().value() == HttpStatus.INTERNAL_SERVER_ERROR.value()) {
			this.diagnosticLogger.log(exception);
		}
		return response;
	}

	private static boolean isReturnValueValidationFailure(Exception exception) {
		return exception instanceof HandlerMethodValidationException validationException
				&& validationException.isForReturnValue();
	}

	private static boolean isMalformedRequest(Exception exception) {
		if (exception instanceof HttpMessageNotReadableException
				|| exception instanceof MethodArgumentTypeMismatchException) {
			return true;
		}
		if (exception instanceof ServletRequestBindingException
				&& !(exception instanceof MissingPathVariableException)) {
			return true;
		}
		if (exception instanceof BindException bindException && hasTypeMismatch(bindException)) {
			return true;
		}
		return exception instanceof HandlerMethodValidationException validationException
				&& hasTypeMismatch(validationException);
	}

	private static boolean hasTypeMismatch(Errors errors) {
		return errors.getAllErrors().stream().anyMatch(ApiExceptionHandler::isTypeMismatch);
	}

	private static boolean hasTypeMismatch(HandlerMethodValidationException exception) {
		for (ParameterValidationResult result : exception.getParameterValidationResults()) {
			if (result instanceof ParameterErrors parameterErrors && hasTypeMismatch(parameterErrors)) {
				return true;
			}
			if (result.getResolvableErrors().stream().anyMatch(ApiExceptionHandler::isTypeMismatch)) {
				return true;
			}
		}
		return exception.getCrossParameterValidationResults().stream().anyMatch(ApiExceptionHandler::isTypeMismatch);
	}

	private static boolean isTypeMismatch(MessageSourceResolvable error) {
		String[] codes = error.getCodes();
		if (codes == null) {
			return false;
		}
		for (String code : codes) {
			if ("TYPE_MISMATCH".equals(normalizeCode(code))) {
				return true;
			}
		}
		return false;
	}

	private List<ApiFieldError> validationErrors(Exception exception) {
		List<ApiFieldError> errors = new ArrayList<>();
		if (exception instanceof MethodArgumentNotValidException methodArgumentNotValidException) {
			addBindingErrors(methodArgumentNotValidException.getBindingResult(), errors);
		}
		else if (exception instanceof BindException bindException) {
			addBindingErrors(bindException, errors);
		}
		else if (exception instanceof HandlerMethodValidationException methodValidationException) {
			addMethodValidationErrors(methodValidationException, errors);
		}
		else if (exception instanceof ConstraintViolationException constraintViolationException) {
			for (ConstraintViolation<?> violation : constraintViolationException.getConstraintViolations()) {
				String field = violation.getPropertyPath() == null ? "request" : violation.getPropertyPath().toString();
				String code = normalizeCode(violation.getConstraintDescriptor().getAnnotation().annotationType().getSimpleName());
				errors.add(new ApiFieldError(field, code, safeValidationMessage(code)));
			}
		}
		else {
			return null;
		}

		errors.sort(Comparator.comparing(ApiFieldError::field)
				.thenComparing(ApiFieldError::code)
				.thenComparing(ApiFieldError::message));
		return errors;
	}

	private static void addBindingErrors(Errors bindingResult, List<ApiFieldError> errors) {
		for (ObjectError error : bindingResult.getAllErrors()) {
			String field = error instanceof FieldError fieldError ? fieldError.getField() : "request";
			String code = normalizeCode(firstCode(error));
			errors.add(new ApiFieldError(field, code, safeValidationMessage(code)));
		}
	}

	private static void addMethodValidationErrors(HandlerMethodValidationException exception,
			List<ApiFieldError> errors) {
		for (ParameterValidationResult result : exception.getParameterValidationResults()) {
			if (result instanceof ParameterErrors parameterErrors) {
				addBindingErrors(parameterErrors, errors);
			}
			else {
				String field = parameterName(result.getMethodParameter());
				for (MessageSourceResolvable error : result.getResolvableErrors()) {
					String code = normalizeCode(firstCode(error));
					errors.add(new ApiFieldError(field, code, safeValidationMessage(code)));
				}
			}
		}
		for (MessageSourceResolvable error : exception.getCrossParameterValidationResults()) {
			String code = normalizeCode(firstCode(error));
			errors.add(new ApiFieldError("parameters", code, safeValidationMessage(code)));
		}
	}

	private static String parameterName(MethodParameter parameter) {
		RequestParam requestParam = parameter.getParameterAnnotation(RequestParam.class);
		if (requestParam != null) {
			if (!requestParam.name().isBlank()) {
				return requestParam.name();
			}
			if (!requestParam.value().isBlank()) {
				return requestParam.value();
			}
		}
		String parameterName = parameter.getParameterName();
		return parameterName == null || parameterName.isBlank() ? "parameter" : parameterName;
	}

	private static String firstCode(MessageSourceResolvable error) {
		String[] codes = error.getCodes();
		return codes == null || codes.length == 0 ? "VALIDATION_ERROR" : codes[0];
	}

	private static String normalizeCode(String code) {
		String normalized = code == null || code.isBlank() ? "VALIDATION_ERROR" : code;
		int separator = normalized.indexOf('.');
		if (separator > 0) {
			normalized = normalized.substring(0, separator);
		}
		normalized = normalized.replaceAll("([a-z0-9])([A-Z])", "$1_$2");
		return normalized.replace('-', '_').toUpperCase(Locale.ROOT);
	}

	private static String safeValidationMessage(String code) {
		return switch (code) {
			case "NOT_BLANK" -> "must not be blank";
			case "NOT_NULL" -> "must not be null";
			case "NOT_EMPTY" -> "must not be empty";
			case "SIZE" -> "has an invalid size";
			case "MIN" -> "must be greater than or equal to the minimum";
			case "MAX" -> "must be less than or equal to the maximum";
			case "POSITIVE" -> "must be positive";
			case "POSITIVE_OR_ZERO" -> "must be positive or zero";
			case "NEGATIVE" -> "must be negative";
			case "NEGATIVE_OR_ZERO" -> "must be negative or zero";
			case "EMAIL" -> "must be a well-formed email address";
			case "PATTERN" -> "has an invalid format";
			case "TYPE_MISMATCH" -> "has an invalid value";
			default -> "is invalid";
		};
	}

	private static ErrorDescriptor errorDescriptor(HttpStatusCode status) {
		if (status == null) {
			return new ErrorDescriptor(ApiErrorCode.INTERNAL_ERROR, INTERNAL_MESSAGE);
		}
		return switch (status.value()) {
			case 400 -> new ErrorDescriptor(ApiErrorCode.MALFORMED_REQUEST, MALFORMED_MESSAGE);
			case 401 -> new ErrorDescriptor(ApiErrorCode.AUTH_REQUIRED, AUTH_REQUIRED_MESSAGE);
			case 403 -> new ErrorDescriptor(ApiErrorCode.AUTHZ_FORBIDDEN, FORBIDDEN_MESSAGE);
			case 404 -> new ErrorDescriptor(ApiErrorCode.NOT_FOUND, NOT_FOUND_MESSAGE);
			case 405 -> new ErrorDescriptor(ApiErrorCode.METHOD_NOT_ALLOWED, METHOD_NOT_ALLOWED_MESSAGE);
			case 406 -> new ErrorDescriptor(ApiErrorCode.NOT_ACCEPTABLE, NOT_ACCEPTABLE_MESSAGE);
			case 409 -> new ErrorDescriptor(ApiErrorCode.CONFLICT, CONFLICT_MESSAGE);
			case 412 -> new ErrorDescriptor(ApiErrorCode.PRECONDITION_FAILED, PRECONDITION_MESSAGE);
			case 413 -> new ErrorDescriptor(ApiErrorCode.PAYLOAD_TOO_LARGE, PAYLOAD_TOO_LARGE_MESSAGE);
			case 415 -> new ErrorDescriptor(ApiErrorCode.UNSUPPORTED_MEDIA_TYPE, MEDIA_TYPE_MESSAGE);
			case 422 -> new ErrorDescriptor(ApiErrorCode.VALIDATION_FAILED, VALIDATION_MESSAGE);
			case 429 -> new ErrorDescriptor(ApiErrorCode.RATE_LIMIT_EXCEEDED, RATE_LIMIT_MESSAGE);
			case 500 -> new ErrorDescriptor(ApiErrorCode.INTERNAL_ERROR, INTERNAL_MESSAGE);
			case 502 -> new ErrorDescriptor(ApiErrorCode.INTERNAL_BAD_GATEWAY, BAD_GATEWAY_MESSAGE);
			case 503 -> new ErrorDescriptor(ApiErrorCode.INTERNAL_SERVICE_UNAVAILABLE, SERVICE_UNAVAILABLE_MESSAGE);
			case 504 -> new ErrorDescriptor(ApiErrorCode.INTERNAL_GATEWAY_TIMEOUT, GATEWAY_TIMEOUT_MESSAGE);
			default -> status.is4xxClientError()
					? new ErrorDescriptor(ApiErrorCode.CLIENT_ERROR, CLIENT_ERROR_MESSAGE)
					: new ErrorDescriptor(ApiErrorCode.INTERNAL_ERROR, INTERNAL_MESSAGE);
		};
	}

	private static HttpStatusCode errorStatus(HttpStatusCode status) {
		if (status != null && (status.is4xxClientError() || status.is5xxServerError())) {
			return status;
		}
		return HttpStatus.INTERNAL_SERVER_ERROR;
	}

	private <T> ResponseEntity<ApiResponse<T>> response(HttpStatusCode status, ApiErrorCode code, String message,
			List<ApiFieldError> errors) {
		return response(status, new ErrorDescriptor(code, message), null, errors);
	}

	private <T> ResponseEntity<ApiResponse<T>> response(HttpStatusCode status, ErrorDescriptor descriptor,
			HttpHeaders headers) {
		return response(status, descriptor, headers, null);
	}

	private <T> ResponseEntity<ApiResponse<T>> response(HttpStatusCode status, ErrorDescriptor descriptor,
			HttpHeaders headers, List<ApiFieldError> errors) {
		ResponseEntity.BodyBuilder response = ResponseEntity.status(status);
		if (headers != null) {
			response.headers(headers);
		}
		response.contentType(MediaType.APPLICATION_JSON);
		return response.body(this.responseFactory.error(descriptor.code(), descriptor.message(), errors));
	}

	private record ErrorDescriptor(ApiErrorCode code, String message) {
	}

}
