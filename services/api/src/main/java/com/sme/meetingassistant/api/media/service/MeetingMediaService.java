package com.sme.meetingassistant.api.media.service;

import com.sme.meetingassistant.api.media.dto.MeetingMediaResponse;
import com.sme.meetingassistant.api.media.entity.MeetingMediaEntity;
import com.sme.meetingassistant.api.media.repository.MeetingMediaRepository;
import com.sme.meetingassistant.api.media.storage.ObjectStorage;
import com.sme.meetingassistant.api.meeting.service.MeetingAccess;
import java.io.BufferedInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.Locale;
import java.util.UUID;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.util.unit.DataSize;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.server.ResponseStatusException;

@Service
public class MeetingMediaService {

	private static final int MAX_FILE_NAME_LENGTH = 255;

	private final MeetingAccess meetingAccess;
	private final MeetingMediaRepository mediaRepository;
	private final ObjectProvider<ObjectStorage> objectStorageProvider;
	private final long maxUploadSizeBytes;

	public MeetingMediaService(MeetingAccess meetingAccess, MeetingMediaRepository mediaRepository,
			ObjectProvider<ObjectStorage> objectStorageProvider,
			@Value("${app.media.max-upload-size:100MB}") DataSize maxUploadSize) {
		this.meetingAccess = meetingAccess;
		this.mediaRepository = mediaRepository;
		this.objectStorageProvider = objectStorageProvider;
		this.maxUploadSizeBytes = maxUploadSize.toBytes();
	}

	public MeetingMediaResponse upload(UUID meetingId, UUID callerId, MultipartFile file) {
		this.meetingAccess.requireAccessible(meetingId, callerId);
		if (file == null || file.isEmpty()) {
			throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY);
		}
		if (file.getSize() > this.maxUploadSizeBytes) {
			throw new ResponseStatusException(HttpStatus.PAYLOAD_TOO_LARGE);
		}

		String fileName = safeFileName(file.getOriginalFilename());
		String extension = extensionOf(fileName);
		String contentType = file.getContentType();
		if (!isSupportedType(extension, contentType)) {
			throw new ResponseStatusException(HttpStatus.UNSUPPORTED_MEDIA_TYPE);
		}
		ObjectStorage objectStorage = this.objectStorageProvider.getIfAvailable();
		if (objectStorage == null) {
			throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE);
		}

		String objectKey = meetingId + "/" + UUID.randomUUID() + "." + extension;
		try (BufferedInputStream content = new BufferedInputStream(file.getInputStream())) {
			validateSignature(content, extension);
			objectStorage.store(objectKey, content, file.getSize(), contentType);
		}
		catch (IOException exception) {
			throw new ResponseStatusException(HttpStatus.BAD_REQUEST);
		}

		MeetingMediaEntity media = new MeetingMediaEntity(meetingId, callerId, fileName, extension, contentType,
				file.getSize(), objectKey);
		try {
			return MeetingMediaResponse.from(this.mediaRepository.saveAndFlush(media));
		}
		catch (RuntimeException persistenceFailure) {
			try {
				objectStorage.delete(objectKey);
			}
			catch (RuntimeException cleanupFailure) {
				persistenceFailure.addSuppressed(cleanupFailure);
			}
			throw persistenceFailure;
		}
	}

	private static String safeFileName(String suppliedName) {
		if (suppliedName == null || suppliedName.isBlank()) {
			throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY);
		}
		String normalized = suppliedName.replace('\\', '/');
		String fileName = normalized.substring(normalized.lastIndexOf('/') + 1).trim();
		if (fileName.isBlank() || fileName.length() > MAX_FILE_NAME_LENGTH) {
			throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY);
		}
		return fileName;
	}

	private static String extensionOf(String fileName) {
		int dot = fileName.lastIndexOf('.');
		if (dot <= 0 || dot == fileName.length() - 1) {
			throw new ResponseStatusException(HttpStatus.UNSUPPORTED_MEDIA_TYPE);
		}
		String extension = fileName.substring(dot + 1).toLowerCase(Locale.ROOT);
		if (!extension.equals("mp3") && !extension.equals("wav")) {
			throw new ResponseStatusException(HttpStatus.UNSUPPORTED_MEDIA_TYPE);
		}
		return extension;
	}

	private static boolean isSupportedType(String extension, String contentType) {
		if (contentType == null) {
			return false;
		}
		String normalized = contentType.toLowerCase(Locale.ROOT);
		return switch (extension) {
			case "mp3" -> normalized.equals("audio/mpeg") || normalized.equals("audio/mp3");
			case "wav" -> normalized.equals("audio/wav") || normalized.equals("audio/x-wav")
					|| normalized.equals("audio/wave") || normalized.equals("audio/vnd.wave");
			default -> false;
		};
	}

	private static void validateSignature(BufferedInputStream content, String extension) throws IOException {
		content.mark(16);
		byte[] header = content.readNBytes(12);
		content.reset();
		boolean valid = switch (extension) {
			case "wav" -> header.length >= 12 && ascii(header, 0, "RIFF") && ascii(header, 8, "WAVE");
			case "mp3" -> header.length >= 3 && (ascii(header, 0, "ID3")
					|| ((header[0] & 0xff) == 0xff && (header[1] & 0xe0) == 0xe0));
			default -> false;
		};
		if (!valid) {
			throw new ResponseStatusException(HttpStatus.UNSUPPORTED_MEDIA_TYPE);
		}
	}

	private static boolean ascii(byte[] value, int offset, String expected) {
		if (value.length < offset + expected.length()) {
			return false;
		}
		for (int index = 0; index < expected.length(); index++) {
			if (value[offset + index] != (byte) expected.charAt(index)) {
				return false;
			}
		}
		return true;
	}

}
