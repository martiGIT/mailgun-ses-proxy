import { SendEmailRequest } from "@aws-sdk/client-sesv2"
import { replaceAll } from "./common"
import { MailgunEvents, MailgunRecipientVariables } from "@/types/default"
import { Prisma } from "../generated"

function doSubstitution(inputText: string | undefined, substitutions: MailgunRecipientVariables[0]): string {
    if (!inputText) {
        return ""
    }
    for (const key of Object.keys(substitutions)) {
        inputText = replaceAll(
            inputText,
            `%recipient.${key}%`,
            substitutions[key as keyof MailgunRecipientVariables[0]]
        )
    }
    return inputText
}

export function preparePayload(input: any, siteId: string): SendEmailRequest[] {
    // Safely parse recipient-variables with fallback to empty object
    let recepientVariables: MailgunRecipientVariables = {}
    try {
        const recipientVarsRaw = input["recipient-variables"]
        if (recipientVarsRaw && recipientVarsRaw !== "undefined" && typeof recipientVarsRaw === "string") {
            recepientVariables = JSON.parse(recipientVarsRaw) as MailgunRecipientVariables
        } else if (recipientVarsRaw && typeof recipientVarsRaw === "object") {
            recepientVariables = recipientVarsRaw as MailgunRecipientVariables
        }
    } catch (error) {
        console.error("Failed to parse recipient-variables:", error)
        recepientVariables = {}
    }

    const receivers = Array.isArray(input.to) ? input.to : [input.to]
    const result = receivers.map((receiverEmail: string | number) => {
        const emailAddress = String(receiverEmail)
        const recipientVars = recepientVariables[receiverEmail] || {}

        // Ensure we have valid html and text content
        // At least one must be present for AWS SES
        const hasHtml = input.html && input.html.trim().length > 0
        const hasText = input.text && input.text.trim().length > 0

        // If neither is present, use a default message
        let htmlContent = hasHtml ? input.html : (hasText ? input.text : "<p>No content</p>")
        let textContent = hasText ? input.text : (hasHtml ? input.html : "No content")

        const emailRequest: SendEmailRequest = {
            ConfigurationSetName: process.env.NEWSLETTER_CONFIGURATION_SET_NAME,
            FromEmailAddress: input.from,
            Destination: { ToAddresses: [emailAddress] },
            Content: {
                Simple: {
                    Subject: {
                        Data: input.subject || "No Subject",
                    },
                    Body: {
                        Text: {
                            Data: doSubstitution(textContent, recipientVars),
                        },
                        Html: {
                            Data: doSubstitution(htmlContent, recipientVars),
                        },
                    },
                    Headers: recipientVars.unsubscribe_url ? [
                        {
                            Name: "List-Unsubscribe-Post",
                            Value: "List-Unsubscribe=One-Click",
                        },
                        {
                            Name: "List-Unsubscribe",
                            Value: `<${recipientVars.unsubscribe_url}>`,
                        },
                    ] : undefined,
                },
            },
            EmailTags: [
                {
                    Name: "siteId",
                    Value: siteId,
                },
                {
                    Name: "batchId",
                    Value: input["v:email-id"] || "no-batch-id",
                },
                {
                    Name: "ghost-email",
                    Value: "true",
                },
            ],
        }

        // Add ReplyToAddresses only if present
        if (input["h:Reply-To"]) {
            emailRequest.ReplyToAddresses = [input["h:Reply-To"]]
        }

        return emailRequest
    })
    return result
}

const awsToMailgunType = {
    Reject: "Rejected",
    Bounce: "Failed",
    // None: "Stored", <- not aws type
    Complaint: "Complained",
    Subscription: "Unsubscribed",
    Click: "Clicked",
    Open: "Opened",
    RenderingFailure: "Rejected",
    Delivery: "Delivered",
    Send: "Accepted",
}

export interface NotificationEvent {
    notificationId: string
    type: string
    messageId: string
    timestamp: Date
    raw: any
}

export function parseNotificationEvent(messageId: string, inputEvent: string): NotificationEvent {
    const event = JSON.parse(inputEvent) as {
        eventType: keyof typeof awsToMailgunType
        mail: { messageId: string, timestamp: Date }
        open?: { timestamp: Date }
    }
    return {
        notificationId: messageId,
        type: String(awsToMailgunType[event.eventType]).toLocaleLowerCase(),
        messageId: event.mail.messageId,
        timestamp: event.open?.timestamp || new Date(),
        raw: inputEvent,
    }
}

type MailgunEventPayload = Prisma.NewsletterNotificationsGetPayload<{
    include: { newsletter: { include: { newsletterBatch: true } } }
}>

export function formatAsMailgunEvent(event: MailgunEventPayload[], url: string) {
    const format = (event: MailgunEventPayload) => {
        const eventTimestamp = (event.timestamp || event.created).getTime()
        const originalSESEvent = JSON.parse(event.rawEvent)
        const out = {
            event: event.type,
            id: `${event.id}-${event.messageId}`,
            timestamp: Math.floor(eventTimestamp / 1000),
            recipient: event.newsletter.toEmail,
            message: {
                headers: {
                    "message-id": event.newsletter.newsletterBatch.batchId,
                    "to": event.newsletter.toEmail
                },
            },
        } as MailgunEvents

        if (originalSESEvent.eventType == "Bounce") {
            out["severity"] = "permanent"
            out["reason"] = "suppress-bounce"
        }

        return out
    }

    return {
        items: event.map(format),
        paging: { next: url },
    }
}
