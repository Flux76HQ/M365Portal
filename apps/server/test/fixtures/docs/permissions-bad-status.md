# Negative fixture: permissions

## Panel catalogue

| Permission   | Reason             | Phase |
| ------------ | ------------------ | ----- |
| `users:read` | Read the user list | C     |

## Graph and Exchange

| Permission or operation | Reason             | Phase | Status        |
| ----------------------- | ------------------ | ----- | ------------- |
| `User.Read.All`         | Read users         | C     | probably fine |
| `Group.Read.All`        | Read groups        | C     | UNVERIFIED    |
| `Mail.Send`             |                    | D     | verified      |
| `Directory.Read.All`    | Read the directory | Z     | verified      |
