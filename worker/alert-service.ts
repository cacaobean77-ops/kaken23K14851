import axios from "axios";

export type AlertConfig = {
    slack?: {
        webhookUrl: string;
    };
    pagerduty?: {
        routingKey: string;
    };
};

export class AlertService {
    constructor(private readonly config: AlertConfig) { }

    async send(message: string, context?: Record<string, any>): Promise<void> {
        const errors: string[] = [];

        // Slack
        if (this.config.slack?.webhookUrl) {
            try {
                await axios.post(this.config.slack.webhookUrl, {
                    text: `[Worker Alert] ${message}`,
                    blocks: [
                        {
                            type: "section",
                            text: {
                                type: "mrkdwn",
                                text: `*Worker Alert*\n${message}`,
                            },
                        },
                        context
                            ? {
                                type: "section",
                                text: {
                                    type: "mrkdwn",
                                    text: "```" + JSON.stringify(context, null, 2) + "```",
                                },
                            }
                            : undefined,
                    ].filter(Boolean),
                });
            } catch (e: any) {
                errors.push(`Slack failed: ${e.message}`);
            }
        }

        // PagerDuty (Events API v2)
        if (this.config.pagerduty?.routingKey) {
            try {
                await axios.post("https://events.pagerduty.com/v2/enqueue", {
                    routing_key: this.config.pagerduty.routingKey,
                    event_action: "trigger",
                    payload: {
                        summary: message,
                        source: "worker",
                        severity: "error",
                        custom_details: context,
                    },
                });
            } catch (e: any) {
                errors.push(`PagerDuty failed: ${e.message}`);
            }
        }

        if (errors.length > 0) {
            console.error("AlertService errors:", errors.join(", "));
        }
    }
}
