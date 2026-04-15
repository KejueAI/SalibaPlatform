# SFTP Server Setup for vAuto

This guide covers setting up the SFTP server on the EC2 instance that receives daily CSV inventory exports from vAuto.

## Overview

vAuto pushes a CSV file daily at 1:00 AM EST via SFTP. Our server receives it, and a cron job at 1:30 AM EST picks it up and processes it into the database.

```
vAuto (1 AM EST) ──SFTP──► EC2 (/home/vauto/uploads/)
                              │
Cron (1:30 AM EST) ───────► Parse CSV ──► Upsert to Postgres
                              │
                          Archive to /home/vauto/archive/
```

## Prerequisites

- EC2 instance running (Amazon Linux 2, Ubuntu, or similar)
- `openssh-server` installed (usually pre-installed)
- Root or sudo access
- Domain `saliba.kejue.co` pointing to the EC2 instance (via Cloudflare)

## Step 1: Create the `vauto` System User

```bash
# Create user with no login shell (SFTP-only)
sudo useradd -m -s /usr/sbin/nologin vauto

# Set a strong password (vAuto will use this to connect)
sudo passwd vauto

# Create the upload and archive directories
sudo mkdir -p /home/vauto/uploads /home/vauto/archive

# Set ownership — root owns the home dir (required for chroot)
sudo chown root:root /home/vauto
sudo chmod 755 /home/vauto

# vauto owns the uploads and archive dirs
sudo chown vauto:vauto /home/vauto/uploads /home/vauto/archive
```

**Important**: For SFTP chroot to work, `/home/vauto` must be owned by `root` and not writable by anyone other than `root`. The `vauto` user writes to `/home/vauto/uploads/` inside the chroot.

## Step 2: Configure SFTP with Chroot

Edit the SSH daemon config:

```bash
sudo nano /etc/ssh/sshd_config
```

Add the following at the **end** of the file:

```
# vAuto SFTP chroot configuration
Match User vauto
    ForceCommand internal-sftp
    ChrootDirectory /home/vauto
    AllowTcpForwarding no
    X11Forwarding no
    PasswordAuthentication yes
```

This configuration:
- Restricts `vauto` to SFTP only (no shell access)
- Chroots them to `/home/vauto` (they see `/uploads/` as their root)
- Disables port forwarding
- Allows password auth for this user

Restart SSH:

```bash
sudo systemctl restart sshd
```

## Step 3: Test the Connection

From your local machine:

```bash
sftp vauto@saliba.kejue.co
# Enter the password when prompted

# Once connected:
sftp> ls
uploads

sftp> cd uploads
sftp> put test.csv
sftp> ls
test.csv

sftp> exit
```

Verify the file landed:

```bash
ls -la /home/vauto/uploads/
# Should show test.csv
```

Clean up the test file:

```bash
sudo rm /home/vauto/uploads/test.csv
```

## Step 4: Firewall Rules

If using a security group (AWS):

```
Type: SSH (or Custom TCP)
Port: 22
Source: vAuto's IP range (ask them for their outbound IPs)
```

If you want extra security, restrict port 22 to only:
- Your own IP (for management)
- vAuto's IP range (for file uploads)
- Kejue office IP (for debugging)

If using `ufw` on the instance:

```bash
# Allow SSH from specific IPs only
sudo ufw allow from <VAUTO_IP> to any port 22
sudo ufw allow from <YOUR_IP> to any port 22
sudo ufw enable
```

## Step 5: Set Up the Cron Job

The Next.js app has an API endpoint that processes vAuto files. Set up a cron job to call it:

```bash
sudo crontab -e
```

Add:

```
# Process vAuto CSV at 1:30 AM EST (6:30 AM UTC)
30 6 * * * curl -s -X POST http://localhost:3000/api/cron/vauto -H "Authorization: Bearer $TOOL_API_KEY" >> /var/log/vauto-cron.log 2>&1
```

Alternatively, if you prefer using the UTC offset:

```
# EST = UTC-5, so 1:30 AM EST = 6:30 AM UTC
# EDT = UTC-4, so 1:30 AM EDT = 5:30 AM UTC
# Adjust for daylight saving time as needed
30 6 * * * curl -s -X POST http://localhost:3000/api/cron/vauto -H "Authorization: Bearer YOUR_API_KEY" >> /var/log/vauto-cron.log 2>&1
```

Set up log rotation:

```bash
sudo tee /etc/logrotate.d/vauto-cron << 'EOF'
/var/log/vauto-cron.log {
    daily
    rotate 14
    compress
    missingok
    notifempty
}
EOF
```

## Step 6: Set Up the Instagram Cron Job

```bash
# Poll Instagram once daily at 10:07 AM EST (3:07 PM UTC)
7 15 * * * curl -s -X POST http://localhost:3000/api/cron/instagram -H "Authorization: Bearer YOUR_API_KEY" >> /var/log/instagram-cron.log 2>&1
```

## Step 7: Set Up Archive Cleanup

The app automatically cleans archives older than 90 days after each import, but as a safety net add this cron job too:

```bash
# Delete CSV archives older than 90 days (weekly on Sunday at 3 AM)
0 8 * * 0 find /home/vauto/archive/ -name "*.csv" -mtime +90 -delete >> /var/log/vauto-cron.log 2>&1
```

## What to Send to vAuto

When vAuto asks for connection details, provide:

| Field | Value |
|---|---|
| Protocol | SFTP |
| Host | `saliba.kejue.co` |
| Port | `22` |
| Username | `vauto` |
| Password | *(the password you set in Step 1)* |
| Remote Directory | `/uploads/` |
| Schedule | Daily at 1:00 AM EST |
| File Format | CSV |
| Delimiter | Comma (`,`) |
| Multi-value Delimiter | Pipe (`\|`) |
| File Naming | `jsautohaus_inventory.csv` or their standard |

## Monitoring

### Check if files are arriving

```bash
# List recent uploads
ls -lt /home/vauto/uploads/

# Check archive for processed files
ls -lt /home/vauto/archive/
```

### Check cron logs

```bash
# vAuto import log
tail -50 /var/log/vauto-cron.log

# Instagram poll log
tail -50 /var/log/instagram-cron.log
```

### Check SSH auth logs

```bash
# See SFTP connections
sudo grep vauto /var/log/auth.log | tail -20
# or on Amazon Linux:
sudo grep vauto /var/log/secure | tail -20
```

## Troubleshooting

### "Connection refused" from vAuto

- Check that `sshd` is running: `sudo systemctl status sshd`
- Check security group allows port 22 from vAuto's IP
- Check `ufw` or `iptables` rules

### "Permission denied" for vauto user

- Verify `/home/vauto` is owned by `root:root` with `755`
- Verify `/home/vauto/uploads` is owned by `vauto:vauto`
- Check `sshd_config` syntax: `sudo sshd -t`

### Files arrive but aren't processed

- Check cron is running: `sudo systemctl status cron`
- Check the Next.js app is running on port 3000
- Check the API key matches: `curl -X POST http://localhost:3000/api/cron/vauto -H "Authorization: Bearer YOUR_KEY"`
- Check logs: `tail /var/log/vauto-cron.log`

### CSV parse errors

- Check the Events page in the dashboard for error details
- Verify column names match the expected mapping in `src/lib/vauto.ts`
- Try a manual import via the dashboard's vAuto page

## Disk Space Management

Old CSVs are archived to `/home/vauto/archive/`. The app automatically cleans archives older than 90 days after each import. As a safety net, the cron job in Step 7 also runs weekly cleanup.
