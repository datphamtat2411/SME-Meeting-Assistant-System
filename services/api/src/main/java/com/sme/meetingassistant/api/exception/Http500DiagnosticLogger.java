package com.sme.meetingassistant.api.exception;

import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.spi.LoggingEventBuilder;
import org.springframework.stereotype.Component;

@Component
final class Http500DiagnosticLogger {

	private static final Logger LOGGER = LoggerFactory.getLogger(Http500DiagnosticLogger.class);
	private static final String EVENT_NAME = "api.http_500";
	private static final String LOG_MESSAGE = "HTTP 500 exception handled";
	private static final String APPLICATION_PACKAGE = "com.sme.meetingassistant.api";
	private static final int MAX_CAUSE_DEPTH = 32;
	private static final int MAX_STACK_FRAMES = 64;
	private static final int MAX_LOCATION_LENGTH = 512;

	void log(Exception exception) {
		Throwable rootCause = rootCause(exception);
		LoggingEventBuilder event = LOGGER.atError()
				.addKeyValue("event", EVENT_NAME)
				.addKeyValue("status", 500)
				.addKeyValue("errorCode", "INTERNAL_ERROR")
				.addKeyValue("exceptionType", exception.getClass().getName());

		if (rootCause != null) {
			event = event.addKeyValue("rootCauseType", rootCause.getClass().getName());
		}

		String failureLocation = failureLocation(exception);
		if (failureLocation != null) {
			event = event.addKeyValue("failureLocation", failureLocation);
		}

		event.log(LOG_MESSAGE);
	}

	private static Throwable rootCause(Throwable exception) {
		Set<Throwable> visited = Collections.newSetFromMap(new IdentityHashMap<>());
		Throwable current = exception;
		Throwable deepest = null;
		int depth = 0;
		while (current != null && depth < MAX_CAUSE_DEPTH && visited.add(current)) {
			deepest = current;
			current = current.getCause();
			depth++;
		}
		return deepest;
	}

	private static String failureLocation(Throwable exception) {
		StackTraceElement[] stackTrace = exception.getStackTrace();
		if (stackTrace == null || stackTrace.length == 0) {
			return null;
		}

		StackTraceElement firstAvailable = null;
		int inspectedFrames = Math.min(stackTrace.length, MAX_STACK_FRAMES);
		for (int index = 0; index < inspectedFrames; index++) {
			StackTraceElement frame = stackTrace[index];
			if (frame == null) {
				continue;
			}
			if (firstAvailable == null) {
				firstAvailable = frame;
			}
			if (isApplicationFrame(frame)) {
				return formatLocation(frame);
			}
		}
		return formatLocation(firstAvailable);
	}

	private static boolean isApplicationFrame(StackTraceElement frame) {
		String className = frame.getClassName();
		return className != null
				&& (APPLICATION_PACKAGE.equals(className) || className.startsWith(APPLICATION_PACKAGE + "."));
	}

	private static String formatLocation(StackTraceElement frame) {
		if (frame == null || frame.getClassName() == null || frame.getMethodName() == null) {
			return null;
		}

		StringBuilder location = new StringBuilder(frame.getClassName().length() + frame.getMethodName().length() + 16)
				.append(frame.getClassName())
				.append('#')
				.append(frame.getMethodName());
		if (frame.getLineNumber() >= 0) {
			location.append(':').append(frame.getLineNumber());
		}
		return location.length() <= MAX_LOCATION_LENGTH
				? location.toString()
				: location.substring(0, MAX_LOCATION_LENGTH);
	}

}
