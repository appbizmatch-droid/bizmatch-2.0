-- Add the two new notification types used by team member management and
-- activity participant assignment (audit items: team join, activity add).
alter type notification_type add value if not exists 'team_joined';
alter type notification_type add value if not exists 'activity_added';
