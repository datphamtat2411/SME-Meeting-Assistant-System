CREATE TABLE foundation_probe (
    id BIGINT PRIMARY KEY,
    description TEXT NOT NULL
);

INSERT INTO foundation_probe (id, description)
VALUES (1, 'migration foundation probe');
