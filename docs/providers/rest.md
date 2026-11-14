# Custom API

A connection the user defines for an HTTPS API this app does not already ship. One SELECT reads one GET path they named. The secret is sent only to the hostname they saved, as a header, and never in the URL.

## Connection

| Field | Role |
| --- | --- |
| Hostname | A public hostname, such as `api.example.com`. `https://` may be pasted and is removed. Plain HTTP, an IP address, and a private or link-local name are refused. |
| Secret | At least 8 characters, with no newline. Bearer sends `Authorization: Bearer`. Basic sends `Authorization: Basic` of the username and the secret. A header sends the secret under the header name they chose. |
| Resource list | Stored on the connection as `apiCatalog`. Each resource has a name, a path that starts with `/`, and an optional rows path such as `data`. |

The Connect APIs board at `/connect` is where the list is written. The connection dialog can change the hostname and the secret and keeps the list.

## Query

One read-only SELECT of one resource. `WHERE`, `ORDER BY`, `LIMIT` and `OFFSET` are applied to that answer. Writes, joins, and `COUNT` are refused before a request. At most 200 rows are read. A redirect is not followed.

`SELECT * FROM items` returns the fields of each JSON object. `SELECT id FROM items WHERE id = '1'` returns that field. A rows path of `data.items` reads that array. An empty rows path expects the body itself to be an array.

## What this connection does not do

It does not call an arbitrary URL. The path is a relative path on the saved hostname. It does not send the secret to any other host, and it does not follow a redirect. It does not open a private, loopback, or link-local address. Agent mode does not write statements for it.
