package com.sme.meetingassistant.api.media.storage;

public class ObjectStorageException extends RuntimeException {

	public ObjectStorageException(Throwable cause) {
		super("Object storage operation failed.", cause);
	}

}
