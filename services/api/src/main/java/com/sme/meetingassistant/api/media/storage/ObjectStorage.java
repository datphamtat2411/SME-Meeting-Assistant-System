package com.sme.meetingassistant.api.media.storage;

import java.io.InputStream;

public interface ObjectStorage {

	void store(String objectKey, InputStream content, long size, String contentType);

	void delete(String objectKey);

}
