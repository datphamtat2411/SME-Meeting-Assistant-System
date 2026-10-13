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
import org.springframework.http.HttpStatus;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.validation.BindException;
import org.springframework.validation.Errors;
import org.springframework.validation.FieldError;
import org.springframework.validation.ObjectError;
import org.springframework.validation.method.ParameterErrors;
import org.springframework.validation.method.ParameterValidationResult;
import org.springframework.web.ErrorResponse;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.HandlerMethodValidationException;
import org.springframework.core.MethodParameter;

@RestControllerAdvice
public class ApiExceptionHandler {

	private static final String MALFORMED_MESSAGE = "Request body is malformed or unreadable.";
	private static final String VALIDATION_MESSAGE = "Request validation failed.";
	private static final String NOT_FOUND_MESSAGE = "The requested resource was not found.";
	private static final String CONFLICT_MESSAGE = "The request conflicts with the current state.";
	private static final String PRECONDITION_MESSAGE = "The request precondition failed.";
	private static final String MEDIA_TYPE_MESSAGE = "The request media type is not supported.";
	private static final String INTERNAL_MESSAGE = "An unexpected error occurred.";

	private final ApiResponseFactory responseFactory;

	public ApiExceptionHandler(ApiResponseFactory responseFactory) {
		this.responseFactory = responseFactory;
	}

	@ExceptionHandler(Exception.class)
	public ResponseEntity<ApiResponse<Void>> handle(Exception exception) {
		if (exception instanceof HttpMessageNotReadableException) {
			return response(HttpStatus.BAD_REQUEST, ApiErrorCode.MALFORMED_REQUEST, MALFORMED_MESSAGE, null);
		}

		List<ApiFieldError> validationErrors = validationErrors(exception);
		if (validationErrors != null) {
			return response(HttpStatus.UNPROCESSABLE_ENTITY, ApiErrorCode.VALIDATION_FAILED, VALIDATION_MESSAGE,
					validationErrors);
		}

		if (exception instanceof ErrorResponse errorResponse) {
			HttpStatusCode status = errorResponse.getStatusCode();
			ApiErrorCode code = errorCode(status);
			return response(status, code, message(code), null);
		}

		return response(HttpStatus.INTERNAL_SERVER_ERROR, ApiErrorCode.INTERNAL_ERROR, INTERNAL_MESSAGE, null);
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
			String field = error instanceof FieldError fieldError ? fieldError.getField() : error.getObjectName();
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

	private static ApiErrorCode errorCode(HttpStatusCode status) {
		return switch (status.value()) {
			case 400 -> ApiErrorCode.MALFORMED_REQUEST;
			case 404 -> ApiErrorCode.NOT_FOUND;
			case 409 -> ApiErrorCode.CONFLICT;
			case 412 -> ApiErrorCode.PRECONDITION_FAILED;
			case 415 -> ApiErrorCode.UNSUPPORTED_MEDIA_TYPE;
			default -> ApiErrorCode.INTERNAL_ERROR;
		};
	}

	private static String message(ApiErrorCode code) {
		return switch (code) {
			case MALFORMED_REQUEST -> MALFORMED_MESSAGE;
			case NOT_FOUND -> NOT_FOUND_MESSAGE;
			case CONFLICT -> CONFLICT_MESSAGE;
			case PRECONDITION_FAILED -> PRECONDITION_MESSAGE;
			case UNSUPPORTED_MEDIA_TYPE -> MEDIA_TYPE_MESSAGE;
			default -> INTERNAL_MESSAGE;
		};
	}

	private <T> ResponseEntity<ApiResponse<T>> response(HttpStatusCode status, ApiErrorCode code, String message,
			List<ApiFieldError> errors) {
		return ResponseEntity.status(status).body(this.responseFactory.error(code, message, errors));
	}

}
