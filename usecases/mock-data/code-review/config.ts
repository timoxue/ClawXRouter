export const config = {
  database: {
    host: "prod-db.internal.company.com",
    port: 5432,
    user: "admin",
    password: "Sup3rS3cret!DB@2026",
    database: "orders_prod"
  },
  aws: {
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    region: "us-east-1"
  },
  stripe: {
    secretKey: "sk-live-51JGxV2CpVZBxM8OvT4P3q2r5s6t7u8v9w0x1y2z3",
    webhookSecret: "whsec_abc123def456ghi789jkl012mno345"
  },
  jwt: {
    secret: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"
  },
  github: {
    token: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh"
  },
  slack: {
    botToken: "xoxb-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUv"
  }
};

export function connectDB() {
  const connStr = `postgresql://${config.database.user}:${config.database.password}@${config.database.host}:${config.database.port}/${config.database.database}`;
  return connStr;
}
