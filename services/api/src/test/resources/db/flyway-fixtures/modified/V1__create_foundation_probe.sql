CREATE TABLE foundation_probe (
    id BIGINT PRIMARY KEY,
    description TEXT NOT NULL,
    modified_marker BOOLEAN NOT NULL DEFAULT FALSE
);

INSERT INTO foundation_probe (id, description, modified_marker)
VALUES (1, 'migration foundation probe', TRUE);
